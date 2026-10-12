package main

import (
	"errors"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"sort"
)

const memberLimit = 4096
const memberStateLimit = 32 * 1024 * 1024

// Only public identity/order metadata is stored. Connection IDs are ephemeral.
type memberRecord struct {
	Instance string         `json:"instance"`
	Digest   string         `json:"digest"`
	Members  map[string]int `json:"members"`
	Next     int            `json:"next"`
	Expires  int64          `json:"expires"`
}
type memberFile struct {
	Version int                      `json:"version"`
	Records map[string]*memberRecord `json:"records"`
}
type Member struct {
	Peer    string `json:"peer"`
	Key     string `json:"key"`
	JoinSeq int    `json:"joinSeq,omitempty"`
}

func (s *Server) loadMembers() error {
	if s.cfg.MemberStateFile == "" {
		return nil
	}
	f, err := os.Open(s.cfg.MemberStateFile)
	if os.IsNotExist(err) {
		return s.saveMembersLocked()
	}
	if err != nil {
		return errors.New("member state could not be loaded")
	}
	defer f.Close()
	b, err := io.ReadAll(io.LimitReader(f, memberStateLimit+1))
	var state memberFile
	if err != nil || len(b) > memberStateLimit || decode(b, &state) != nil || state.Version != 1 || state.Records == nil || len(state.Records) > 8192 {
		return errors.New("invalid member state")
	}
	for instance, r := range state.Records {
		if r == nil || instance != r.Instance || !validHex(instance, 16) || !validHex(r.Digest, 32) || r.Members == nil || len(r.Members) > memberLimit || r.Next != len(r.Members)+1 || r.Expires <= 0 {
			return errors.New("invalid member state")
		}
		seen := map[int]bool{}
		for key, seq := range r.Members {
			if !validHex(key, 32) || seq < 1 || seq >= r.Next || seen[seq] {
				return errors.New("invalid member state")
			}
			seen[seq] = true
		}
	}
	s.memberRecords = state.Records
	return nil
}

// Caller holds s.mu. A record is visible on the wire only after this returns.
func (s *Server) saveMembersLocked() error {
	if s.cfg.MemberStateFile == "" {
		return nil
	}
	b := wire(memberFile{1, s.memberRecords})
	if len(b) > memberStateLimit || len(s.memberRecords) > 8192 {
		return errors.New("member state capacity")
	}
	dir := filepath.Dir(s.cfg.MemberStateFile)
	if err := os.MkdirAll(dir, 0700); err != nil {
		return errors.New("member state write failed")
	}
	f, err := os.CreateTemp(dir, ".romzo-members-*")
	if err != nil {
		return errors.New("member state write failed")
	}
	name := f.Name()
	defer os.Remove(name)
	if _, err = f.Write(b); err == nil {
		err = f.Sync()
	}
	closeErr := f.Close()
	if err == nil {
		err = closeErr
	}
	if err == nil {
		err = os.Rename(name, s.cfg.MemberStateFile)
	}
	// Unix needs the directory entry synced as well. Windows Go exposes file
	// Sync and atomic replacement, but not a portable directory fsync.
	if err == nil && runtime.GOOS != "windows" {
		d, openErr := os.Open(dir)
		if openErr != nil {
			err = openErr
		} else {
			err = d.Sync()
			_ = d.Close()
		}
	}
	if err != nil {
		return errors.New("member state write failed")
	}
	return nil
}

func (s *Server) pruneMembersLocked() {
	active := map[string]bool{}
	for _, room := range s.rooms {
		active[room.Signed.Descriptor.Instance] = true
	}
	for instance, r := range s.memberRecords {
		if !active[instance] && r.Expires <= s.now().UnixMilli() {
			delete(s.memberRecords, instance)
		}
	}
}

// prepareMembersLocked is also used before issuing any recovery ticket.
func (s *Server) prepareMembersLocked(room *Room, expires int64) error {
	if s.cfg.MemberStateFile == "" {
		return nil
	}
	d := room.Signed.Descriptor
	r := s.memberRecords[d.Instance]
	created := r == nil
	if created {
		r = &memberRecord{d.Instance, hash("romzo/relay-descriptor/v1", room.Signed), map[string]int{}, 1, expires}
		s.memberRecords[d.Instance] = r
	}
	if r.Digest != hash("romzo/relay-descriptor/v1", room.Signed) {
		return errors.New("member state conflict")
	}
	old := r.Expires
	if expires > r.Expires {
		r.Expires = expires
	}
	if !created && old == r.Expires {
		return nil
	}
	s.pruneMembersLocked()
	if err := s.saveMembersLocked(); err != nil {
		if created {
			delete(s.memberRecords, d.Instance)
		} else {
			r.Expires = old
		}
		return err
	}
	return nil
}

func (s *Server) registerMemberLocked(room *Room, key string) (int, error) {
	if s.cfg.MemberStateFile == "" {
		return 0, nil
	}
	r := s.memberRecords[room.Signed.Descriptor.Instance]
	if r == nil || r.Digest != hash("romzo/relay-descriptor/v1", room.Signed) {
		return 0, errors.New("member state unavailable")
	}
	if seq := r.Members[key]; seq != 0 {
		return seq, nil
	}
	if len(r.Members) >= memberLimit {
		return 0, errors.New("member capacity")
	}
	seq := r.Next
	r.Members[key] = seq
	r.Next++
	if err := s.saveMembersLocked(); err != nil {
		delete(r.Members, key)
		r.Next--
		return 0, err
	}
	return seq, nil
}

func channelMembers(room *Room, channel string) []Member {
	members := []Member{}
	for _, p := range room.Peers {
		if p.channels[channel] {
			members = append(members, Member{p.id, p.key, p.joinSeq})
		}
	}
	sort.Slice(members, func(i, j int) bool {
		if members[i].JoinSeq == members[j].JoinSeq {
			return members[i].Peer < members[j].Peer
		}
		return members[i].JoinSeq < members[j].JoinSeq
	})
	return members
}

func presenceFrame(kind, channel string, p *Peer) map[string]any {
	f := map[string]any{"v": protocol, "kind": kind, "channel": channel, "peer": p.id, "key": p.key}
	if p.joinSeq > 0 {
		f["joinSeq"] = p.joinSeq
	}
	return f
}
