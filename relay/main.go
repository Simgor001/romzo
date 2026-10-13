package main

import (
	"bufio"
	"context"
	"fmt"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"
)

func main() {
	if len(os.Args) == 2 && os.Args[1] == "init" {
		fmt.Printf("CREATE_AUTH=password\nCREATE_PASSWORD=%s\nAUTH_SALT=%s\nTICKET_KEY=%s\nGRANT_KEY=%s\nMETRICS_KEY=%s\n", randomHex(24), randomHex(32), randomHex(32), randomHex(32), randomHex(32))
		return
	}
	if len(os.Args) == 2 && os.Args[1] == "rotate-password" {
		fmt.Printf("CREATE_PASSWORD=%s\nAUTH_SALT=%s\n", randomHex(24), randomHex(32))
		return
	}
	if len(os.Args) == 2 && os.Args[1] == "-version" {
		fmt.Println(version)
		return
	}
	if len(os.Args) == 2 && os.Args[1] == "-health" {
		os.Exit(runHealthCheck())
	}
	if len(os.Args) == 3 && os.Args[1] == "--env-file" {
		if e := loadEnv(os.Args[2]); e != nil {
			fmt.Fprintln(os.Stderr, "configuration file could not be loaded")
			os.Exit(1)
		}
	} else if len(os.Args) != 1 {
		fmt.Fprintln(os.Stderr, "usage: relay [init | rotate-password | -version | -health | --env-file PATH]")
		os.Exit(1)
	}
	c, e := config()
	if e != nil {
		fmt.Fprintln(os.Stderr, e)
		os.Exit(1)
	}
	s := newServer(c)
	if e = s.loadMembers(); e != nil {
		fmt.Fprintln(os.Stderr, e)
		os.Exit(1)
	}
	if e = s.loadHistory(); e != nil {
		fmt.Fprintln(os.Stderr, e)
		os.Exit(1)
	}
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	go func() {
		tick := time.NewTicker(time.Second)
		defer tick.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-tick.C:
				s.mu.Lock()
				s.sweepLocked()
				s.mu.Unlock()
				if tickTime := time.Now(); tickTime.Unix()%10 == 0 {
					if e := s.saveHistory(); e != nil {
						fmt.Fprintln(os.Stderr, e)
					}
				}
			}
		}
	}()
	h := &http.Server{Addr: c.Listen, Handler: withHSTS(s), ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 10 * time.Second, WriteTimeout: 10 * time.Second, IdleTimeout: 60 * time.Second, MaxHeaderBytes: 16 * 1024}
	shutdownDone := make(chan struct{})
	go func() {
		defer close(shutdownDone)
		<-ctx.Done()
		shutdown, done := context.WithTimeout(context.Background(), 5*time.Second)
		defer done()
		s.mu.Lock()
		for _, room := range s.rooms {
			for _, peer := range room.Peers {
				peer.cancel()
			}
		}
		s.mu.Unlock()
		_ = h.Shutdown(shutdown)
		if e := s.saveHistory(); e != nil {
			fmt.Fprintln(os.Stderr, e)
		}
	}()
	fmt.Fprintln(os.Stderr, "romzo relay ready")
	if e = h.ListenAndServe(); e != nil && e != http.ErrServerClosed {
		fmt.Fprintln(os.Stderr, "listen failed")
		os.Exit(1)
	}
	<-shutdownDone
}

// withHSTS pins HTTPS-only access for browsers; over plain HTTP the header
// is ignored, so loopback development is unaffected.
func withHSTS(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Strict-Transport-Security", "max-age=31536000")
		next.ServeHTTP(w, r)
	})
}

func loadEnv(path string) error {
	f, e := os.Open(path)
	if e != nil {
		return e
	}
	defer f.Close()
	scanner := bufio.NewScanner(f)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		key, value, ok := strings.Cut(line, "=")
		key = strings.TrimSpace(key)
		value = strings.TrimSpace(value)
		if !ok || key == "" || strings.ContainsAny(key, " \t\r\n") {
			return fmt.Errorf("invalid env")
		}
		if strings.HasPrefix(value, "\"") {
			value, e = strconv.Unquote(value)
			if e != nil {
				return e
			}
		} else if strings.HasPrefix(value, "'") {
			if !strings.HasSuffix(value, "'") || len(value) < 2 {
				return fmt.Errorf("invalid env")
			}
			value = value[1 : len(value)-1]
		}
		if _, exists := os.LookupEnv(key); !exists {
			if e = os.Setenv(key, value); e != nil {
				return e
			}
		}
	}
	return scanner.Err()
}

// runHealthCheck reports whether a relay is answering on its listen address.
// It backs the container HEALTHCHECK and lets orchestrators roll back a bad
// deployment automatically; exits 0 on a healthy discovery document.
func runHealthCheck() int {
	addr := os.Getenv("LISTEN")
	if addr == "" {
		addr = "127.0.0.1:9224"
	}
	if strings.HasPrefix(addr, ":") {
		addr = "127.0.0.1" + addr
	}
	// Bare IPv6 literals need brackets before they can go into a URL.
	if strings.Count(addr, ":") > 1 && !strings.HasPrefix(addr, "[") {
		addr = "[" + addr + "]"
	}
	client := http.Client{Timeout: 3 * time.Second}
	resp, err := client.Get("http://" + addr + "/.well-known/romzo")
	if err != nil {
		return 1
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return 1
	}
	return 0
}
