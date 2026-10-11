package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestMetricsAuthorization(t *testing.T) {
	key := strings.Repeat("m", 64) // Public fixture, never a deployment key.
	for _, tc := range []struct {
		name, configured, header, path, origin string
		duplicate                              bool
		status                                 int
	}{
		{name: "disabled", status: 404},
		{name: "disabled with key", header: "Bearer " + key, status: 404},
		{name: "missing", configured: key, status: 401},
		{name: "incorrect", configured: key, header: "Bearer " + strings.Repeat("n", 64), status: 401},
		{name: "wrong scheme", configured: key, header: "Basic " + key, status: 401},
		{name: "extra whitespace", configured: key, header: "Bearer  " + key, status: 401},
		{name: "duplicate", configured: key, header: "Bearer " + key, duplicate: true, status: 401},
		{name: "query token rejected", configured: key, path: api + "metrics?key=" + key, status: 400},
		{name: "origin is not auth", configured: key, origin: "http://client.test", status: 401},
		{name: "denied origin", configured: key, header: "Bearer " + key, origin: "http://denied.test", status: 403},
		{name: "valid", configured: key, header: "Bearer " + key, status: 200},
		{name: "valid origin", configured: key, header: "Bearer " + key, origin: "http://client.test", status: 200},
	} {
		t.Run(tc.name, func(t *testing.T) {
			c := testConfig()
			c.MetricsKey = tc.configured
			s := newServer(c)
			path := tc.path
			if path == "" {
				path = api + "metrics"
			}
			r := httptest.NewRequest("GET", path, nil)
			r.RemoteAddr = "127.0.0.1:1234"
			if tc.header != "" {
				r.Header.Set("Authorization", tc.header)
			}
			if tc.duplicate {
				r.Header.Add("Authorization", tc.header)
			}
			if tc.origin != "" {
				r.Header.Set("Origin", tc.origin)
			}
			w := httptest.NewRecorder()
			s.ServeHTTP(w, r)
			if w.Code != tc.status {
				t.Fatalf("got %d, want %d", w.Code, tc.status)
			}
			if strings.Contains(w.Body.String(), key) {
				t.Fatal("key leaked in response")
			}
			if tc.status == 401 && w.Header().Get("WWW-Authenticate") == "" {
				t.Fatal("missing auth challenge")
			}
			if tc.status == 200 {
				var snapshot map[string]any
				if json.Unmarshal(w.Body.Bytes(), &snapshot) != nil || snapshot["rooms"] != float64(0) || snapshot["receivedFrames"] != float64(0) {
					t.Fatal("invalid metrics snapshot")
				}
				if w.Header().Get("Cache-Control") != "no-store" {
					t.Fatal("metrics must not be cached")
				}
			} else if strings.Contains(w.Body.String(), "receivedFrames") {
				t.Fatal("metrics leaked without authorization")
			}
		})
	}
	c := testConfig()
	c.MetricsKey = key
	preflight := httptest.NewRequest("OPTIONS", api+"metrics", nil)
	preflight.Header.Set("Origin", "http://client.test")
	preflight.Header.Set("Access-Control-Request-Headers", "authorization")
	w := httptest.NewRecorder()
	newServer(c).ServeHTTP(w, preflight)
	if w.Code != 204 || w.Header().Get("Access-Control-Allow-Headers") != "Authorization" || w.Body.Len() != 0 {
		t.Fatal("metrics preflight must allow auth header without exposing data")
	}
	server := httptest.NewServer(newServer(c))
	defer server.Close()
	req, _ := http.NewRequest("GET", server.URL+api+"metrics", nil)
	req.Header.Set("Authorization", "Bearer "+key)
	resp, err := server.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatal("real HTTP request failed")
	}
}
func TestMetricsKeyConfiguration(t *testing.T) {
	t.Setenv("PUBLIC_ORIGIN", "http://127.0.0.1")
	t.Setenv("AUTH_SALT", strings.Repeat("ab", 32))
	t.Setenv("AUTH_SALT_FILE", "")
	t.Setenv("TICKET_KEY", strings.Repeat("cd", 32))
	t.Setenv("TICKET_KEY_FILE", "")
	t.Setenv("CREATE_AUTH", "anonymous")
	t.Setenv("TURNSTILE_SECRET", "")
	t.Setenv("TURNSTILE_SECRET_FILE", "")
	t.Setenv("METRICS_KEY_FILE", "")
	for _, key := range []string{"", strings.Repeat("m", 64)} {
		t.Setenv("METRICS_KEY", key)
		c, err := config()
		if err != nil || c.MetricsKey != key {
			t.Fatal("valid metrics configuration rejected")
		}
	}
	for _, key := range []string{"short", strings.Repeat("m", 257), strings.Repeat("m", 32) + " ", strings.Repeat("m", 32) + "\n", strings.Repeat("m", 32) + "中"} {
		t.Setenv("METRICS_KEY", key)
		if _, err := config(); err == nil {
			t.Fatal("invalid metrics configuration accepted")
		}
	}
	key := strings.Repeat("p", 64)
	path := filepath.Join(t.TempDir(), "metrics.key")
	if err := os.WriteFile(path, []byte(key+"\n"), 0600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("METRICS_KEY", "")
	t.Setenv("METRICS_KEY_FILE", path)
	for i := 0; i < 2; i++ {
		c, err := config()
		if err != nil || c.MetricsKey != key {
			t.Fatal("persisted key not loaded")
		}
	}
	t.Setenv("METRICS_KEY", key)
	if _, err := config(); err == nil {
		t.Fatal("ambiguous key sources accepted")
	}
}
