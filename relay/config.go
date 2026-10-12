package main

import (
	"crypto/pbkdf2"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"net"
	"net/url"
	"os"
	"strconv"
	"strings"
)

type Config struct {
	NodeOutboundBytesPerSecond                   int
	Listen, Origin, Auth                         string
	MetricsHistoryFile                           string
	RecordCreatorIP                              bool
	MaxRoomBytes                                 int64
	MaxRoomSeconds                               int
	MetricsKey                                   string
	Salt, TicketKey, Verifier                    []byte
	TurnstileSecret, TurnstileURL                string
	ClientOrigins                                []string
	AdminOrigins                                 []string
	TrustedProxies                               []*net.IPNet
	Rooms, Connections, Unauthenticated, PerRoom int
	FramesPerSecond, BytesPerSecond              int
	IPBytesPerSecond, OptionsBytes               int
}

func config() (Config, error) {
	c := Config{Listen: env("LISTEN", ":9224"), Origin: os.Getenv("PUBLIC_ORIGIN"), Auth: env("CREATE_AUTH", "password")}
	u, e := url.Parse(c.Origin)
	if e != nil || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || (u.Path != "" && u.Path != "/") || (u.Scheme != "https" && !(u.Scheme == "http" && (u.Hostname() == "localhost" || u.Hostname() == "127.0.0.1" || u.Hostname() == "::1"))) {
		return c, errors.New("PUBLIC_ORIGIN must be a canonical HTTPS origin (HTTP only on loopback)")
	}
	u.Host = strings.ToLower(u.Host)
	if port := u.Port(); port != "" {
		n, err := strconv.Atoi(port)
		if err != nil || n < 1 || n > 65535 {
			return c, errors.New("invalid PUBLIC_ORIGIN port")
		}
		if (u.Scheme == "https" && port == "443") || (u.Scheme == "http" && port == "80") {
			host := u.Hostname()
			if strings.Contains(host, ":") {
				host = "[" + host + "]"
			}
			u.Host = host
		}
	}
	c.Origin = u.Scheme + "://" + u.Host
	salt, e := secretEnv("AUTH_SALT")
	if e != nil {
		return c, e
	}
	c.Salt, e = hex.DecodeString(salt)
	if e != nil || len(c.Salt) != 32 {
		return c, errors.New("AUTH_SALT must be 32 bytes of hex")
	}
	ticketKey, e := secretEnv("TICKET_KEY")
	if e != nil {
		return c, e
	}
	c.TicketKey, e = hex.DecodeString(ticketKey)
	if e != nil || len(c.TicketKey) != 32 {
		return c, errors.New("TICKET_KEY must be 32 bytes of hex")
	}
	switch c.Auth {
	case "password":
		password, err := secretEnv("CREATE_PASSWORD")
		if err != nil {
			return c, err
		}
		if password == "" {
			return c, errors.New("CREATE_PASSWORD required; anonymous creation must be explicit")
		}
		c.Verifier, e = pbkdf2.Key(sha256.New, password, c.Salt, 600000, 32)
		if e != nil {
			return c, e
		}
	case "anonymous", "off":
	default:
		return c, errors.New("invalid CREATE_AUTH")
	}
	c.MetricsKey, e = secretEnv("METRICS_KEY")
	if e != nil {
		return c, e
	}
	if c.MetricsKey != "" {
		if len(c.MetricsKey) < 32 || len(c.MetricsKey) > 256 {
			return c, errors.New("METRICS_KEY must contain 32 to 256 printable ASCII characters without spaces")
		}
		for _, ch := range c.MetricsKey {
			if ch < 33 || ch > 126 {
				return c, errors.New("invalid METRICS_KEY character")
			}
		}
	}
	c.TurnstileSecret, e = secretEnv("TURNSTILE_SECRET")
	if e != nil {
		return c, e
	}
	if c.TurnstileSecret != "" {
		c.TurnstileURL = os.Getenv("TURNSTILE_VERIFY_URL")
		if c.TurnstileURL == "" {
			c.TurnstileURL = "https://challenges.cloudflare.com/turnstile/v0/siteverify"
		}
		u, e := url.Parse(c.TurnstileURL)
		if e != nil || (u.Scheme != "https" && u.Scheme != "http") || u.Host == "" || u.RawQuery != "" || u.Fragment != "" {
			return c, errors.New("invalid TURNSTILE_VERIFY_URL")
		}
	}
	c.ClientOrigins = strings.Split(env("CLIENT_ORIGINS", c.Origin), ",")
	if len(c.ClientOrigins) != 1 || c.ClientOrigins[0] != "*" {
		if err := validateOrigins(c.ClientOrigins); err != nil {
			return c, errors.New("CLIENT_ORIGINS must be * or a comma-separated list of exact HTTP(S) origins")
		}
	}
	c.AdminOrigins = strings.Split(env("ADMIN_ORIGINS", c.Origin), ",")
	if err := validateOrigins(c.AdminOrigins); err != nil {
		return c, errors.New("ADMIN_ORIGINS must contain exact HTTP(S) origins; wildcard is not allowed")
	}
	for _, cidr := range strings.Split(os.Getenv("TRUSTED_PROXIES"), ",") {
		if cidr == "" {
			continue
		}
		_, network, err := net.ParseCIDR(strings.TrimSpace(cidr))
		if err != nil {
			return c, errors.New("invalid TRUSTED_PROXIES")
		}
		c.TrustedProxies = append(c.TrustedProxies, network)
	}
	for _, item := range []struct {
		name            string
		target          *int
		value, min, max int
	}{
		{"MAX_ROOMS", &c.Rooms, 64, 1, 4096}, {"MAX_CONNECTIONS", &c.Connections, 512, 1, 32768}, {"MAX_UNAUTHENTICATED", &c.Unauthenticated, 64, 1, 512}, {"MAX_ROOM_CONNECTIONS", &c.PerRoom, 32, 2, 128}, {"FRAMES_PER_SECOND", &c.FramesPerSecond, 64, 1, 1024}, {"BYTES_PER_SECOND", &c.BytesPerSecond, 1048576, frameLimit / 2, 16777216},
		{"IP_BYTES_PER_SECOND", &c.IPBytesPerSecond, 1048576, frameLimit / 2, 16777216}, {"MAX_OPTIONS_BYTES", &c.OptionsBytes, 4096, 1, 4096},
	} {
		n, err := strconv.Atoi(env(item.name, strconv.Itoa(item.value)))
		if err != nil || n < item.min || n > item.max {
			return c, errors.New("invalid " + item.name)
		}
		*item.target = n
	}
	c.RecordCreatorIP, e = strconv.ParseBool(env("RECORD_CREATOR_IP", "false"))
	if e != nil {
		return c, errors.New("invalid RECORD_CREATOR_IP")
	}
	c.MetricsHistoryFile = os.Getenv("METRICS_HISTORY_FILE")
	c.MaxRoomBytes, e = strconv.ParseInt(env("MAX_ROOM_TRAFFIC_BYTES", "0"), 10, 64)
	if e != nil || c.MaxRoomBytes < 0 || c.MaxRoomBytes > 1<<52 {
		return c, errors.New("invalid MAX_ROOM_TRAFFIC_BYTES")
	}
	c.NodeOutboundBytesPerSecond, e = strconv.Atoi(env("NODE_OUTBOUND_BYTES_PER_SECOND", "0"))
	if e != nil || c.NodeOutboundBytesPerSecond < 0 || c.NodeOutboundBytesPerSecond > 16777216 {
		return c, errors.New("invalid NODE_OUTBOUND_BYTES_PER_SECOND")
	}
	c.MaxRoomSeconds, e = strconv.Atoi(env("MAX_ROOM_AGE_SECONDS", "0"))
	if e != nil || c.MaxRoomSeconds < 0 || c.MaxRoomSeconds > 31536000 {
		return c, errors.New("invalid MAX_ROOM_AGE_SECONDS")
	}
	return c, nil
}
func validWebOrigin(origin string) bool {
	u, err := url.Parse(origin)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" || u.Hostname() == "" || u.User != nil || u.RawQuery != "" || u.ForceQuery || u.Fragment != "" || u.Path != "" {
		return false
	}
	if origin != u.Scheme+"://"+u.Host || strings.HasSuffix(u.Host, ":") || strings.Contains(u.Host, "*") {
		return false
	}
	if port := u.Port(); port != "" {
		n, err := strconv.Atoi(port)
		if err != nil || n < 1 || n > 65535 {
			return false
		}
	}
	return true
}

func validateOrigins(origins []string) error {
	for i, origin := range origins {
		origin = strings.TrimSpace(origin)
		if !validWebOrigin(origin) {
			return errors.New("invalid web origin")
		}
		origins[i] = origin
	}
	return nil
}

func secretEnv(name string) (string, error) {
	value, path := os.Getenv(name), os.Getenv(name+"_FILE")
	if path == "" {
		return value, nil
	}
	if value != "" {
		return "", errors.New("ambiguous secret configuration")
	}
	data, e := os.ReadFile(path)
	if e != nil || len(data) > 4096 {
		return "", errors.New("secret file could not be read")
	}
	return strings.TrimRight(string(data), "\r\n"), nil
}
func env(k, d string) string {
	if v, ok := os.LookupEnv(k); ok {
		return v
	}
	return d
}
