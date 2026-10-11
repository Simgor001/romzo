package main

import "net/http"

func (s *Server) moderate(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path != api+"admin/rooms/stop" {
		failure(w, 404, "not_found")
		return
	}
	if r.Method != "POST" {
		w.Header().Set("Allow", "POST")
		failure(w, 405, "method_not_allowed")
		return
	}
	var body struct {
		ID string `json:"id"`
	}
	if !readBody(w, r, &body) {
		return
	}
	if !validHex(body.ID, 12) {
		failure(w, 400, "invalid_request")
		return
	}
	s.mu.Lock()
	if !s.allowLocked("admin-stop/"+s.clientIP(r), 2, 10) {
		s.mu.Unlock()
		failure(w, 429, "rate_limited")
		return
	}
	record := s.monitor.records[body.ID]
	if record == nil {
		s.mu.Unlock()
		failure(w, 404, "room_not_found")
		return
	}
	// Keep a tombstone longer than any currently valid restore lease.
	record.StopReason = "admin_stopped"
	record.EndedAt = s.now().UnixMilli()
	record.UpdatedAt = record.EndedAt
	for code, room := range s.rooms {
		if room.MonitorID == body.ID {
			s.stopRoomLocked(room, "admin_stopped")
			delete(s.rooms, code)
			delete(s.requests, room.Request.RequestID)
		}
	}
	s.mu.Unlock()
	if s.saveHistory() != nil {
		failure(w, 500, "history_save_failed")
		return
	}
	result(w, 200, map[string]bool{"ok": true})
}
