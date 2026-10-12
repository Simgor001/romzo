package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
)

func TestPublicOriginsKeepManagementPrivate(t *testing.T) {
	c := testConfig()
	c.ClientOrigins = []string{"*"}
	c.MetricsKey = strings.Repeat("m", 64)
	s := newServer(c)
	for _, tc := range []struct {
		method, path, origin string
		status               int
	}{
		{"GET", "/.well-known/romzo", "https://new-game.example", 200},
		{"OPTIONS", api + "rooms", "http://localhost:5390", 204},
		{"GET", "/.well-known/romzo", "null", 403},
		{"GET", "/.well-known/romzo", "https://example.com/path", 403},
		{"GET", "/.well-known/romzo", "file://example.com", 403},
		{"GET", api + "metrics", "https://new-game.example", 403},
		{"OPTIONS", api + "admin/rooms/stop", "https://new-game.example", 403},
		{"GET", api + "metrics", "http://client.test", 401},
	} {
		r := httptest.NewRequest(tc.method, tc.path, nil)
		r.Header.Set("Origin", tc.origin)
		w := httptest.NewRecorder()
		s.ServeHTTP(w, r)
		if w.Code != tc.status {
			t.Fatalf("%s %s origin %s: got %d, want %d", tc.method, tc.path, tc.origin, w.Code, tc.status)
		}
		if tc.status < 400 && w.Header().Get("Access-Control-Allow-Origin") != tc.origin {
			t.Fatal("missing origin-specific CORS response")
		}
		if tc.status == 403 && w.Header().Get("Access-Control-Allow-Origin") != "" {
			t.Fatal("denied origin received CORS permission")
		}
		if w.Header().Get("Access-Control-Allow-Credentials") != "" {
			t.Fatal("public API must not enable cookie credentials")
		}
	}
}

func TestPublicWebSocketOriginStillRequiresAuthentication(t *testing.T) {
	c := testConfig()
	c.ClientOrigins = []string{"*"}
	s := newServer(c)
	_, _, key, ticket, _ := allocateTest(t, s)
	h := httptest.NewServer(s)
	defer h.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	ws := strings.Replace(h.URL, "http", "ws", 1) + wsPath
	for _, origin := range []string{"https://new-game.example", ""} {
		conn, _, err := websocket.Dial(ctx, ws, &websocket.DialOptions{HTTPHeader: http.Header{"Origin": []string{origin}}})
		if err != nil {
			t.Fatal(err)
		}
		writeTest(t, conn, map[string]any{"v": protocol, "kind": "authenticate", "admission": ticket})
		challenge := readTest(t, conn)
		if challenge["kind"] != "challenge" {
			t.Fatal("missing authentication challenge")
		}
		writeTest(t, conn, map[string]any{"v": protocol, "kind": "proof", "signature": signed(key, "romzo/relay-connect/v1", challenge["value"])})
		if readTest(t, conn)["kind"] != "authenticated" {
			t.Fatal("authentication failed")
		}
		conn.CloseNow()
	}
	conn, _, err := websocket.Dial(ctx, ws, &websocket.DialOptions{HTTPHeader: http.Header{"Origin": []string{"https://new-game.example"}}})
	if err != nil {
		t.Fatal(err)
	}
	writeTest(t, conn, map[string]any{"v": protocol, "kind": "subscribe", "channel": "table", "id": "without-auth"})
	if _, _, err := conn.Read(ctx); err == nil {
		t.Fatal("public origin bypassed admission authentication")
	}
	conn.CloseNow()
	_, resp, err := websocket.Dial(ctx, ws, &websocket.DialOptions{HTTPHeader: http.Header{"Origin": []string{"null"}}})
	if err == nil || resp == nil || resp.StatusCode != 403 {
		t.Fatal("opaque browser origin accepted")
	}
}

func TestOriginConfiguration(t *testing.T) {
	t.Setenv("PUBLIC_ORIGIN", "https://relay.example")
	t.Setenv("AUTH_SALT", strings.Repeat("ab", 32))
	t.Setenv("TICKET_KEY", strings.Repeat("cd", 32))
	t.Setenv("CREATE_AUTH", "anonymous")
	t.Setenv("ADMIN_ORIGINS", "https://relay.example")
	for _, value := range []string{"*", "https://game.example", "https://game.example, http://localhost:5390"} {
		t.Setenv("CLIENT_ORIGINS", value)
		if _, err := config(); err != nil {
			t.Fatal(err)
		}
	}
	for _, value := range []string{"*,https://game.example", "null", "file://game.example", "https://game.example/", "https://game.example:99999", "https://game.example:", "https://game.example#", "https://*.example", ""} {
		t.Setenv("CLIENT_ORIGINS", value)
		if _, err := config(); err == nil {
			t.Fatalf("invalid origins accepted: %q", value)
		}
	}
	t.Setenv("CLIENT_ORIGINS", "*")
	t.Setenv("ADMIN_ORIGINS", "*")
	if _, err := config(); err == nil {
		t.Fatal("wildcard management origins accepted")
	}
}
