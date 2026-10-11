package main

import (
	"embed"
	"net/http"
)

//go:embed admin/index.html admin/style.css admin/app.js
var adminAssets embed.FS

func (s *Server) serveAdmin(w http.ResponseWriter, r *http.Request) {
	if s.cfg.MetricsKey == "" {
		failure(w, 404, "not_found")
		return
	}
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		w.Header().Set("Allow", "GET, HEAD")
		failure(w, 405, "method_not_allowed")
		return
	}
	paths := map[string]string{"/admin/": "admin/index.html", "/admin/style.css": "admin/style.css", "/admin/app.js": "admin/app.js"}
	path, ok := paths[r.URL.Path]
	if !ok {
		failure(w, 404, "not_found")
		return
	}
	data, err := adminAssets.ReadFile(path)
	if err != nil {
		failure(w, 500, "internal_error")
		return
	}
	types := map[string]string{"admin/index.html": "text/html; charset=utf-8", "admin/style.css": "text/css; charset=utf-8", "admin/app.js": "text/javascript; charset=utf-8"}
	w.Header().Set("Content-Type", types[path])
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Referrer-Policy", "no-referrer")
	w.Header().Set("Content-Security-Policy", "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'")
	if r.Method == http.MethodGet {
		_, _ = w.Write(data)
	}
}
