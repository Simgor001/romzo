package main

import (
	"net/http/httptest"
	"strings"
	"testing"
)

func TestAdminAssets(t *testing.T) {
	for _, tc := range []struct {
		path, method, content string
		enabled               bool
		status                int
	}{
		{"/admin/", "GET", "text/html", true, 200},
		{"/admin/style.css", "GET", "text/css", true, 200},
		{"/admin/app.js", "GET", "text/javascript", true, 200},
		{"/admin/", "HEAD", "text/html", true, 200},
		{"/admin/", "GET", "", false, 404},
		{"/admin/app.js", "GET", "", false, 404},
		{"/admin/unknown", "GET", "", true, 404},
		{"/admin/", "POST", "", true, 405},
		{"/admin/?key=invalid", "GET", "", true, 400},
	} {
		t.Run(tc.method+tc.path+tc.content, func(t *testing.T) {
			c := testConfig()
			if tc.enabled {
				c.MetricsKey = strings.Repeat("m", 64)
			}
			s := newServer(c)
			w := httptest.NewRecorder()
			s.ServeHTTP(w, httptest.NewRequest(tc.method, tc.path, nil))
			if w.Code != tc.status {
				t.Fatalf("got %d, expected %d", w.Code, tc.status)
			}
			if tc.status == 200 {
				if !strings.Contains(w.Header().Get("Content-Type"), tc.content) || !strings.Contains(w.Header().Get("Content-Security-Policy"), "frame-ancestors 'none'") || w.Header().Get("Cache-Control") != "no-store" || w.Header().Get("X-Content-Type-Options") != "nosniff" {
					t.Fatal("missing asset protection")
				}
				if tc.method == "HEAD" && w.Body.Len() != 0 {
					t.Fatal("HEAD returned a body")
				}
				if strings.Contains(w.Body.String(), c.MetricsKey) {
					t.Fatal("key embedded in static asset")
				}
			}
		})
	}
}
