package main

import (
	"encoding/json"
	"errors"
	"time"
)

type identityPolicy struct {
	Exclusive bool  `json:"exclusive"`
	TTL       int64 `json:"ttlMs"`
}

func readIdentityPolicy(options json.RawMessage) (*identityPolicy, error) {
	var root map[string]json.RawMessage
	if json.Unmarshal(options, &root) != nil {
		return nil, nil
	}
	raw, ok := root["identityPolicy"]
	if !ok {
		return nil, nil
	}
	var p identityPolicy
	if decode(raw, &p) != nil || !p.Exclusive || p.TTL <= 0 || p.TTL > int64((1<<63-1)/int64(time.Millisecond)) {
		return nil, errors.New("invalid identity policy")
	}
	return &p, nil
}

func identityTTL(room *Room) time.Duration {
	p, _ := readIdentityPolicy(room.Signed.Descriptor.Options)
	if p != nil {
		return time.Duration(p.TTL) * time.Millisecond
	}
	return 30 * time.Minute
}

// The retained key deadline is authoritative. Allow an old signed ticket to
// cover disconnect cleanup; this grace cannot extend the retained identity.
func recoveryTTL(room *Room) time.Duration {
	ttl := identityTTL(room)
	policy, _ := readIdentityPolicy(room.Signed.Descriptor.Options)
	if policy != nil && ttl <= time.Duration(1<<63-1)-time.Minute {
		return ttl + time.Minute
	}
	return ttl
}

func (s *Server) pruneIdentitiesLocked(room *Room) {
	r := s.memberRecords[room.Signed.Descriptor.Instance]
	if r == nil || r.KeyExpires == nil {
		return
	}
	active := map[string]bool{}
	for _, p := range room.Peers {
		active[p.key] = true
	}
	for key, expiry := range r.KeyExpires {
		if !active[key] && expiry <= s.now().UnixMilli() {
			delete(r.KeyExpires, key)
			delete(r.Members, key)
		}
	}
}

func (s *Server) touchIdentityLocked(room *Room, key string) error {
	p, _ := readIdentityPolicy(room.Signed.Descriptor.Options)
	if p == nil {
		return nil
	}
	r := s.memberRecords[room.Signed.Descriptor.Instance]
	if r == nil {
		return errors.New("member state unavailable")
	}
	if r.KeyExpires == nil {
		r.KeyExpires = map[string]int64{}
	}
	old := r.KeyExpires[key]
	oldRoomExpiry := r.Expires
	if r.Members[key] != 0 {
		r.KeyExpires[key] = s.now().Add(identityTTL(room)).UnixMilli()
		if r.KeyExpires[key] > r.Expires {
			r.Expires = r.KeyExpires[key]
		}
	}
	if err := s.saveMembersLocked(); err != nil {
		r.Expires = oldRoomExpiry
		if old == 0 {
			delete(r.KeyExpires, key)
		} else {
			r.KeyExpires[key] = old
		}
		return err
	}
	return nil
}
