package main

import (
	"encoding/json"
	"errors"
	"io"
	"net"
	"os"
	"path/filepath"
	"sort"
	"sync"
	"time"
)

const historyRetention = 24 * time.Hour
const historyRecordLimit = 5120

type roomRecord struct {
	Code            string `json:"code,omitempty"`
	CreatorIP       string `json:"creatorIP,omitempty"`
	ID              string `json:"id"`
	ObservedAt      int64  `json:"observedAt"`
	UpdatedAt       int64  `json:"updatedAt"`
	EndedAt         int64  `json:"endedAt,omitempty"`
	ReceivedBytes   int64  `json:"receivedBytes"`
	SentBytes       int64  `json:"sentBytes"`
	OnlineMillis    int64  `json:"onlineMillis"`
	StopReason      string `json:"stopReason,omitempty"`
	lastAt          time.Time
	online          bool
	onlineRemainder time.Duration
}
type roomView struct {
	Code          string `json:"code,omitempty"`
	CreatorIP     string `json:"creatorIP,omitempty"`
	ID            string `json:"id"`
	Active        bool   `json:"active"`
	Connections   int    `json:"connections"`
	Channels      int    `json:"channels"`
	ReceivedBytes int64  `json:"receivedBytes"`
	SentBytes     int64  `json:"sentBytes"`
	OnlineSeconds int64  `json:"onlineSeconds"`
	ObservedAt    int64  `json:"observedAt"`
	EndedAt       int64  `json:"endedAt,omitempty"`
	StopReason    string `json:"stopReason,omitempty"`
}
type roomHistoryView struct {
	NodeOutboundBytesPerSecond int        `json:"nodeOutboundBytesPerSecond"`
	TrafficTop                 []roomView `json:"trafficTop"`
	OnlineTop                  []roomView `json:"onlineTop"`
	Persistent                 bool       `json:"persistent"`
	WriteError                 bool       `json:"writeError"`
	MaxBytes                   int64      `json:"maxBytes"`
	MaxSeconds                 int        `json:"maxSeconds"`
}
type roomMonitor struct {
	records    map[string]*roomRecord
	writeMu    sync.Mutex
	writeError bool
}

func (s *Server) attachRoomRecordLocked(r *Room) *roomRecord {
	if s.monitor.records == nil {
		s.monitor.records = map[string]*roomRecord{}
	}
	id := mac(s.cfg.TicketKey, "romzo/metrics-room/v1", map[string]string{"origin": s.cfg.Origin, "instance": r.Signed.Descriptor.Instance})[:24]
	if r.Signed.Descriptor.Instance == "" {
		id = randomHex(12)
	}
	r.MonitorID = id
	record := s.monitor.records[id]
	if record == nil {
		s.pruneHistoryLocked()
		if len(s.monitor.records) >= historyRecordLimit {
			return nil
		}
		record = &roomRecord{ID: id, ObservedAt: s.now().UnixMilli()}
		s.monitor.records[id] = record
	}
	if record.StopReason == "" {
		record.EndedAt = 0
	}
	record.Code = r.Signed.Descriptor.Code
	if !s.cfg.RecordCreatorIP {
		record.CreatorIP = ""
	}
	record.UpdatedAt = s.now().UnixMilli()
	record.lastAt = s.now()
	record.online = false
	return record
}
func (s *Server) sampleRoomLocked(r *Room) *roomRecord {
	record := s.monitor.records[r.MonitorID]
	if record == nil {
		record = s.attachRoomRecordLocked(r)
	}
	now := s.now()
	if record.online && !record.lastAt.IsZero() && now.After(record.lastAt) {
		record.onlineRemainder += now.Sub(record.lastAt)
		millis := record.onlineRemainder.Milliseconds()
		record.OnlineMillis += millis
		record.onlineRemainder -= time.Duration(millis) * time.Millisecond
	}
	record.lastAt = now
	record.online = len(r.Peers) > 0
	record.UpdatedAt = now.UnixMilli()
	return record
}
func (s *Server) stopRoomLocked(r *Room, reason string) {
	record := s.sampleRoomLocked(r)
	if record.StopReason == "" {
		record.StopReason = reason
		record.EndedAt = s.now().UnixMilli()
	}
	for _, p := range r.Peers {
		if p.cancel != nil {
			p.cancel()
		}
	}
}
func (s *Server) roomLimitLocked(r *Room, extra int64) bool {
	record := s.sampleRoomLocked(r)
	reason := record.StopReason
	if reason == "" && s.cfg.MaxRoomSeconds > 0 && s.now().UnixMilli()-record.ObservedAt >= int64(s.cfg.MaxRoomSeconds)*1000 {
		reason = "room_lifetime_limit"
	}
	if reason == "" && s.cfg.MaxRoomBytes > 0 && extra > s.cfg.MaxRoomBytes-record.ReceivedBytes-record.SentBytes {
		reason = "room_traffic_limit"
	}
	if reason != "" {
		s.stopRoomLocked(r, reason)
		return true
	}
	return false
}
func (s *Server) pruneHistoryLocked() {
	active := map[string]bool{}
	for _, r := range s.rooms {
		active[r.MonitorID] = true
	}

	for id, r := range s.monitor.records {
		if active[id] {
			continue
		}
		if r.EndedAt == 0 {
			r.EndedAt = r.UpdatedAt
		}
		if s.now().UnixMilli()-r.EndedAt >= historyRetention.Milliseconds() {
			delete(s.monitor.records, id)
			continue
		}

	}

}
func (s *Server) roomHistoryLocked() roomHistoryView {
	live := map[string]*Room{}
	for _, r := range s.rooms {
		s.sampleRoomLocked(r)
		live[r.MonitorID] = r
	}
	s.pruneHistoryLocked()
	v := roomHistoryView{NodeOutboundBytesPerSecond: s.cfg.NodeOutboundBytesPerSecond, TrafficTop: []roomView{}, OnlineTop: []roomView{}, Persistent: s.cfg.MetricsHistoryFile != "", WriteError: s.monitor.writeError, MaxBytes: s.cfg.MaxRoomBytes, MaxSeconds: s.cfg.MaxRoomSeconds}
	for _, r := range s.monitor.records {
		row := roomView{ID: r.ID, Code: r.Code, CreatorIP: r.CreatorIP, ReceivedBytes: r.ReceivedBytes, SentBytes: r.SentBytes, OnlineSeconds: r.OnlineMillis / 1000, ObservedAt: r.ObservedAt, EndedAt: r.EndedAt, StopReason: r.StopReason}
		if room := live[r.ID]; room != nil {
			row.Active = r.StopReason == ""
			row.Connections = len(room.Peers)
			row.Channels = len(room.Channels)
		}
		v.TrafficTop = append(v.TrafficTop, row)
		if row.Active && row.Connections > 0 {
			v.OnlineTop = append(v.OnlineTop, row)
		}
	}
	sort.Slice(v.TrafficTop, func(i, j int) bool {
		a, b := v.TrafficTop[i], v.TrafficTop[j]
		if a.ReceivedBytes+a.SentBytes == b.ReceivedBytes+b.SentBytes {
			return a.ID < b.ID
		}
		return a.ReceivedBytes+a.SentBytes > b.ReceivedBytes+b.SentBytes
	})
	sort.Slice(v.OnlineTop, func(i, j int) bool {
		a, b := v.OnlineTop[i], v.OnlineTop[j]
		if a.OnlineSeconds == b.OnlineSeconds {
			return a.ID < b.ID
		}
		return a.OnlineSeconds > b.OnlineSeconds
	})
	v.TrafficTop = v.TrafficTop[:min(10, len(v.TrafficTop))]
	v.OnlineTop = v.OnlineTop[:min(10, len(v.OnlineTop))]
	return v
}
func (s *Server) loadHistory() error {
	if s.cfg.MetricsHistoryFile == "" {
		return nil
	}
	f, err := os.Open(s.cfg.MetricsHistoryFile)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return errors.New("metrics history could not be loaded")
	}
	defer f.Close()
	var records []*roomRecord
	decoder := json.NewDecoder(io.LimitReader(f, 4*1024*1024+1))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&records) != nil || len(records) > historyRecordLimit {
		return errors.New("invalid metrics history")
	}
	var extra any
	if decoder.Decode(&extra) != io.EOF {
		return errors.New("invalid metrics history")
	}
	s.monitor.records = map[string]*roomRecord{}
	for _, r := range records {
		if r == nil || !validHex(r.ID, 12) || r.ObservedAt <= 0 || r.UpdatedAt < r.ObservedAt || r.EndedAt < 0 || (r.EndedAt > 0 && (r.EndedAt < r.ObservedAt || r.EndedAt > r.UpdatedAt)) || r.ReceivedBytes < 0 || r.SentBytes < 0 || r.ReceivedBytes > 1<<52 || r.SentBytes > 1<<52 || r.OnlineMillis < 0 || r.OnlineMillis > r.UpdatedAt-r.ObservedAt || (r.StopReason != "" && r.StopReason != "room_lifetime_limit" && r.StopReason != "room_traffic_limit" && r.StopReason != "admin_stopped") || s.monitor.records[r.ID] != nil {
			return errors.New("invalid metrics history")
		}
		if r.CreatorIP != "" && net.ParseIP(r.CreatorIP) == nil {
			return errors.New("invalid metrics history")
		}
		if len(r.Code) > 32 {
			return errors.New("invalid metrics history")
		}
		if !s.cfg.RecordCreatorIP {
			r.CreatorIP = ""
		}
		s.monitor.records[r.ID] = r
	}
	// No offline time counts as online. Restores may reattach the stable opaque ID.
	return nil
}
func (s *Server) saveHistory() error {
	if s.cfg.MetricsHistoryFile == "" {
		return nil
	}
	s.monitor.writeMu.Lock()
	defer s.monitor.writeMu.Unlock()
	s.mu.Lock()
	for _, r := range s.rooms {
		s.sampleRoomLocked(r)
	}
	s.pruneHistoryLocked()
	records := []roomRecord{}
	for _, r := range s.monitor.records {
		records = append(records, *r)
	}
	s.mu.Unlock()
	sort.Slice(records, func(i, j int) bool { return records[i].ID < records[j].ID })
	data, err := json.Marshal(records)
	if err == nil {
		dir := filepath.Dir(s.cfg.MetricsHistoryFile)
		err = os.MkdirAll(dir, 0700)
		if err == nil {
			var f *os.File
			f, err = os.CreateTemp(dir, ".romzo-history-*")
			if err == nil {
				name := f.Name()
				defer os.Remove(name)
				err = f.Chmod(0600)
				if err == nil {
					_, err = f.Write(data)
				}
				if err == nil {
					err = f.Sync()
				}
				closeErr := f.Close()
				if err == nil {
					err = closeErr
				}
				if err == nil {
					err = os.Rename(name, s.cfg.MetricsHistoryFile)
				}
			}
		}
	}
	s.mu.Lock()
	s.monitor.writeError = err != nil
	s.mu.Unlock()
	if err != nil {
		return errors.New("metrics history could not be saved")
	}
	return nil
}
