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
		fmt.Printf("CREATE_AUTH=password\nCREATE_PASSWORD=%s\nAUTH_SALT=%s\nTICKET_KEY=%s\n", randomHex(24), randomHex(32), randomHex(32))
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
	if len(os.Args) == 3 && os.Args[1] == "--env-file" {
		if e := loadEnv(os.Args[2]); e != nil {
			fmt.Fprintln(os.Stderr, "configuration file could not be loaded")
			os.Exit(1)
		}
	} else if len(os.Args) != 1 {
		fmt.Fprintln(os.Stderr, "usage: relay [init | rotate-password | -version | --env-file PATH]")
		os.Exit(1)
	}
	c, e := config()
	if e != nil {
		fmt.Fprintln(os.Stderr, e)
		os.Exit(1)
	}
	s := newServer(c)
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
			}
		}
	}()
	h := &http.Server{Addr: c.Listen, Handler: s, ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 10 * time.Second, WriteTimeout: 10 * time.Second, IdleTimeout: 60 * time.Second, MaxHeaderBytes: 16 * 1024}
	go func() {
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
	}()
	fmt.Fprintln(os.Stderr, "romzo relay ready")
	if e = h.ListenAndServe(); e != nil && e != http.ErrServerClosed {
		fmt.Fprintln(os.Stderr, "listen failed")
		os.Exit(1)
	}
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
