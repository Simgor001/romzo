package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strings"
)

func (s *Server) serveTurnstilePage(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	parent := q.Get("parent")
	u, err := url.Parse(parent)
	if s.cfg.TurnstileSiteKey == "" || s.cfg.TurnstileSecret == "" {
		failure(w, 404, "not_found")
		return
	}
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" || u.User != nil || u.Path != "" || u.RawQuery != "" || u.Fragment != "" || !s.originAllowed(parent) || !validHex(q.Get("host"), 32) || !validHex(q.Get("request"), 16) {
		failure(w, 400, "invalid_request")
		return
	}
	nonce := randomHex(16)
	cfg, _ := json.Marshal(map[string]string{"parent": parent, "host": q.Get("host"), "request": q.Get("request"), "sitekey": s.cfg.TurnstileSiteKey, "action": s.cfg.TurnstileAction})
	ancestors := strings.Join(s.cfg.ClientOrigins, " ")
	if ancestors == "*" {
		ancestors = "http: https:"
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Referrer-Policy", "no-referrer")
	w.Header().Set("Content-Security-Policy", "default-src 'none'; script-src 'nonce-"+nonce+"' https://challenges.cloudflare.com; frame-src https://challenges.cloudflare.com; connect-src 'self' https://challenges.cloudflare.com; style-src 'nonce-"+nonce+"'; frame-ancestors "+ancestors)
	fmt.Fprintf(w, `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Romzo verification</title><style nonce="%s">body{margin:0;background:#faf7f5;color:#222;font:16px system-ui;text-align:center}#box{display:flex;justify-content:center}p{color:#626660}</style></head><body><p>Romzo · 验证后继续 / Verify to continue</p><div id="box"></div><p id="status" role="status"></p><script nonce="%s">const cfg=%s;let finished=false;function fail(error){if(finished)return;finished=true;parent.postMessage({type:'romzo-grant-error',request:cfg.request,error},cfg.parent);document.querySelector('#status').textContent='验证失败，请重试 / Verification failed';}function ready(){turnstile.render('#box',{sitekey:cfg.sitekey,action:cfg.action||undefined,theme:'light',size:'compact',callback:async token=>{try{const response=await fetch('/api/v1/verify',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({turnstile:token,host:cfg.host})});const data=await response.json();if(!response.ok){fail(data.error||'attestation_failed');return;}if(finished)return;finished=true;parent.postMessage({type:'romzo-grant',request:cfg.request,grant:data.grant},cfg.parent);}catch{fail('attestation_failed');}},'error-callback':()=>{fail('turnstile_failed');return true;},'expired-callback':()=>fail('attestation_expired')});}window.ready=ready;</script><script nonce="%s" src="https://challenges.cloudflare.com/turnstile/v0/api.js?onload=ready&amp;render=explicit" async defer></script></body></html>`, nonce, nonce, string(cfg), nonce)
}
