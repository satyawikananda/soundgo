// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 SoundGo contributors
//
// Zero-dependency HLS-to-HTTP audio relay for SoundGo in MyGo Music.
//
// SoundCloud serves audio as plain HLS (typically fMP4 AAC-LC segments with an
// init.mp4 map, or legacy MP3/MPEG-TS segments). MyGo Music natively decodes
// ADTS AAC and MP3 streams progressively, so this helper parses the .m3u8
// playlist, unwraps fMP4/MPEG-TS segments into continuous ADTS AAC or MP3
// frames without lossy re-encoding, and serves them over 127.0.0.1.

package main

import (
	"bufio"
	"bytes"
	"context"
	"crypto/rand"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"
)

const (
	helperVersion = "1.0.0"
	defaultUA     = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36"
	streamTTL     = 15 * time.Minute
	maxStreams    = 32
	maxSegBytes   = 32 << 20
	prefetchAhead = 2
)

type streamFormat int

const (
	formatUnknown streamFormat = iota
	formatFMP4AAC
	formatADTS
	formatMP3
	formatMPEGTS
)

type aacConfig struct {
	audioObjectType byte
	freqIndex       byte
	channelConfig   byte
	trackID         uint32
	defaultSampleSz uint32
}

type registeredStream struct {
	id         string
	createdAt  time.Time
	format     streamFormat
	audioType  string // "aac" or "mp3"
	mimeType   string
	segments   []string
	aac        aacConfig
	tsAudioPID uint16
	firstSeg   []byte // cached segment 0 when probed during register
	headers    map[string]string
}

type server struct {
	client  *http.Client
	mu      sync.Mutex
	streams map[string]*registeredStream
}

func newServer(client *http.Client) *server {
	if client == nil {
		tr := http.DefaultTransport.(*http.Transport).Clone()
		tr.Proxy = http.ProxyFromEnvironment
		client = &http.Client{
			Transport: tr,
			Timeout:   30 * time.Second,
		}
	}
	return &server{
		client:  client,
		streams: make(map[string]*registeredStream),
	}
}

func main() {
	if len(os.Args) > 1 && (os.Args[1] == "-version" || os.Args[1] == "--version") {
		fmt.Printf("soundgo-hls-helper %s\n", helperVersion)
		return
	}

	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		fmt.Fprintf(os.Stderr, "listen failed: %v\n", err)
		os.Exit(1)
	}

	s := newServer(nil)
	mux := http.NewServeMux()
	mux.HandleFunc("/register", s.handleRegister)
	mux.HandleFunc("/stream/", s.handleStream)
	mux.HandleFunc("/health", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	})

	httpSrv := &http.Server{
		Handler:           mux,
		ReadHeaderTimeout: 10 * time.Second,
	}

	// Exit cleanly when the parent plugin closes stdin or exits.
	go func() {
		_, _ = io.Copy(io.Discard, os.Stdin)
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		_ = httpSrv.Shutdown(ctx)
	}()

	port := ln.Addr().(*net.TCPAddr).Port
	fmt.Printf("{\"port\":%d}\n", port)
	_ = os.Stdout.Sync()

	if err := httpSrv.Serve(ln); err != nil && !errors.Is(err, http.ErrServerClosed) {
		fmt.Fprintf(os.Stderr, "serve failed: %v\n", err)
		os.Exit(1)
	}
}

type registerRequest struct {
	URL     string            `json:"url"`
	Headers map[string]string `json:"headers,omitempty"`
}

type registerResponse struct {
	ID   string `json:"id"`
	Type string `json:"type"`
	URL  string `json:"url"`
}

func (s *server) handleRegister(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var req registerRequest
	if err := json.NewDecoder(io.LimitReader(r.Body, 1<<20)).Decode(&req); err != nil {
		writeJSONError(w, http.StatusBadRequest, "invalid JSON request")
		return
	}
	if req.URL == "" {
		writeJSONError(w, http.StatusBadRequest, "missing playlist url")
		return
	}

	st, err := s.prepareStream(r.Context(), req.URL, req.Headers)
	if err != nil {
		writeJSONError(w, http.StatusUnprocessableEntity, err.Error())
		return
	}

	s.putStream(st)

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(registerResponse{
		ID:   st.id,
		Type: st.audioType,
		URL:  fmt.Sprintf("http://%s/stream/%s", r.Host, st.id),
	})
}

func writeJSONError(w http.ResponseWriter, status int, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]string{"error": msg})
}

func (s *server) putStream(st *registeredStream) {
	s.mu.Lock()
	defer s.mu.Unlock()
	now := time.Now()
	for id, existing := range s.streams {
		if now.Sub(existing.createdAt) > streamTTL {
			delete(s.streams, id)
		}
	}
	for len(s.streams) >= maxStreams {
		var oldestID string
		var oldestAt time.Time
		for id, existing := range s.streams {
			if oldestID == "" || existing.createdAt.Before(oldestAt) {
				oldestID = id
				oldestAt = existing.createdAt
			}
		}
		delete(s.streams, oldestID)
	}
	s.streams[st.id] = st
}

func (s *server) getStream(id string) *registeredStream {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.streams[id]
}

func (s *server) handleStream(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	id := strings.TrimPrefix(r.URL.Path, "/stream/")
	st := s.getStream(id)
	if st == nil {
		http.NotFound(w, r)
		return
	}

	w.Header().Set("Content-Type", st.mimeType)
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusOK)
	if r.Method == http.MethodHead {
		return
	}

	flusher, _ := w.(http.Flusher)
	ctx := r.Context()

	type segResult struct {
		data []byte
		err  error
	}

	// Bounded lookahead prefetch so playback stays ahead of real time without
	// buffering the entire track in memory.
	jobs := make(chan int, len(st.segments))
	results := make([]chan segResult, len(st.segments))
	for i := range st.segments {
		results[i] = make(chan segResult, 1)
	}

	sem := make(chan struct{}, prefetchAhead)
	go func() {
		defer close(jobs)
		for i := range st.segments {
			select {
			case <-ctx.Done():
				return
			case sem <- struct{}{}:
			}
			idx := i
			go func() {
				var data []byte
				var err error
				if idx == 0 && len(st.firstSeg) > 0 {
					data = st.firstSeg
				} else {
					data, err = s.fetchBytesWithRetry(ctx, st.segments[idx], st.headers)
				}
				results[idx] <- segResult{data: data, err: err}
			}()
		}
	}()

	tsDemux := &tsAudioDemuxer{pid: st.tsAudioPID}

	for i := range st.segments {
		var res segResult
		select {
		case <-ctx.Done():
			return
		case res = <-results[i]:
			// Release prefetch slot once this segment is handed to the writer.
			select {
			case <-sem:
			default:
			}
		}
		if res.err != nil {
			return
		}

		var out []byte
		var err error
		switch st.format {
		case formatFMP4AAC:
			out, err = fmp4SegmentToADTS(res.data, st.aac)
		case formatADTS, formatMP3:
			out = res.data
		case formatMPEGTS:
			out = tsDemux.feed(res.data)
		default:
			return
		}
		if err != nil {
			return
		}
		if len(out) > 0 {
			if _, err := w.Write(out); err != nil {
				return
			}
			if flusher != nil {
				flusher.Flush()
			}
		}
	}

	if st.format == formatMPEGTS {
		if tail := tsDemux.flush(); len(tail) > 0 {
			_, _ = w.Write(tail)
			if flusher != nil {
				flusher.Flush()
			}
		}
	}
}

func (s *server) fetchBytes(ctx context.Context, rawURL string, headers map[string]string) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, rawURL, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", defaultUA)
	for k, v := range headers {
		if v != "" {
			req.Header.Set(k, v)
		}
	}
	resp, err := s.client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("upstream answered %d", resp.StatusCode)
	}
	data, err := io.ReadAll(io.LimitReader(resp.Body, maxSegBytes+1))
	if err != nil {
		return nil, err
	}
	if len(data) > maxSegBytes {
		return nil, errors.New("segment too large")
	}
	return data, nil
}

func (s *server) fetchBytesWithRetry(ctx context.Context, rawURL string, headers map[string]string) ([]byte, error) {
	var lastErr error
	for attempt := 0; attempt < 3; attempt++ {
		if attempt > 0 {
			select {
			case <-ctx.Done():
				return nil, ctx.Err()
			case <-time.After(time.Duration(attempt) * 250 * time.Millisecond):
			}
		}
		data, err := s.fetchBytes(ctx, rawURL, headers)
		if err == nil {
			return data, nil
		}
		lastErr = err
	}
	return nil, lastErr
}

type parsedPlaylist struct {
	initURL  string
	segments []string
	variants []playlistVariant
}

type playlistVariant struct {
	bandwidth int
	url       string
}

func parseM3U8(baseURL string, body []byte) (*parsedPlaylist, error) {
	base, err := url.Parse(baseURL)
	if err != nil {
		return nil, err
	}
	resolve := func(ref string) (string, error) {
		u, err := url.Parse(strings.TrimSpace(ref))
		if err != nil {
			return "", err
		}
		return base.ResolveReference(u).String(), nil
	}

	pl := &parsedPlaylist{}
	sc := bufio.NewScanner(bytes.NewReader(body))
	sc.Buffer(make([]byte, 64*1024), 4*1024*1024)

	pendingBandwidth := -1
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" {
			continue
		}
		if strings.HasPrefix(line, "#") {
			if strings.HasPrefix(line, "#EXT-X-KEY:") {
				method := parseAttr(line[len("#EXT-X-KEY:"):], "METHOD")
				if method != "" && !strings.EqualFold(method, "NONE") {
					return nil, fmt.Errorf("encrypted HLS stream (%s) is unsupported", method)
				}
			} else if strings.HasPrefix(line, "#EXT-X-MAP:") {
				uri := parseAttr(line[len("#EXT-X-MAP:"):], "URI")
				if uri != "" {
					resolved, err := resolve(uri)
					if err != nil {
						return nil, err
					}
					pl.initURL = resolved
				}
			} else if strings.HasPrefix(line, "#EXT-X-STREAM-INF:") {
				bw := 0
				if raw := parseAttr(line[len("#EXT-X-STREAM-INF:"):], "BANDWIDTH"); raw != "" {
					fmt.Sscanf(raw, "%d", &bw)
				}
				pendingBandwidth = bw
			}
			continue
		}

		resolved, err := resolve(line)
		if err != nil {
			return nil, err
		}
		if pendingBandwidth >= 0 {
			pl.variants = append(pl.variants, playlistVariant{
				bandwidth: pendingBandwidth,
				url:       resolved,
			})
			pendingBandwidth = -1
		} else {
			pl.segments = append(pl.segments, resolved)
		}
	}
	if err := sc.Err(); err != nil {
		return nil, err
	}
	return pl, nil
}

func parseAttr(attrs, key string) string {
	want := key + "="
	for i := 0; i < len(attrs); {
		for i < len(attrs) && (attrs[i] == ',' || attrs[i] == ' ' || attrs[i] == '\t') {
			i++
		}
		if i >= len(attrs) {
			break
		}
		eq := strings.IndexByte(attrs[i:], '=')
		if eq < 0 {
			break
		}
		k := strings.TrimSpace(attrs[i : i+eq])
		vStart := i + eq + 1
		var val string
		if vStart < len(attrs) && attrs[vStart] == '"' {
			vStart++
			end := strings.IndexByte(attrs[vStart:], '"')
			if end < 0 {
				val = attrs[vStart:]
				i = len(attrs)
			} else {
				val = attrs[vStart : vStart+end]
				i = vStart + end + 1
			}
		} else {
			end := strings.IndexByte(attrs[vStart:], ',')
			if end < 0 {
				val = strings.TrimSpace(attrs[vStart:])
				i = len(attrs)
			} else {
				val = strings.TrimSpace(attrs[vStart : vStart+end])
				i = vStart + end + 1
			}
		}
		if strings.EqualFold(k+"=", want) {
			return val
		}
	}
	return ""
}

func (s *server) prepareStream(ctx context.Context, playlistURL string, headers map[string]string) (*registeredStream, error) {
	body, err := s.fetchBytesWithRetry(ctx, playlistURL, headers)
	if err != nil {
		return nil, fmt.Errorf("fetch playlist: %w", err)
	}
	pl, err := parseM3U8(playlistURL, body)
	if err != nil {
		return nil, err
	}

	// Follow master playlist to highest-bandwidth media playlist.
	if len(pl.segments) == 0 && len(pl.variants) > 0 {
		best := pl.variants[0]
		for _, v := range pl.variants[1:] {
			if v.bandwidth > best.bandwidth {
				best = v
			}
		}
		body, err = s.fetchBytesWithRetry(ctx, best.url, headers)
		if err != nil {
			return nil, fmt.Errorf("fetch variant playlist: %w", err)
		}
		pl, err = parseM3U8(best.url, body)
		if err != nil {
			return nil, err
		}
	}
	if len(pl.segments) == 0 {
		return nil, errors.New("playlist has no segments")
	}

	st := &registeredStream{
		id:        randomID(),
		createdAt: time.Now(),
		segments:  pl.segments,
		headers:   headers,
	}

	if pl.initURL != "" {
		initData, err := s.fetchBytesWithRetry(ctx, pl.initURL, headers)
		if err != nil {
			return nil, fmt.Errorf("fetch init segment: %w", err)
		}
		cfg, err := parseInitMP4(initData)
		if err != nil {
			return nil, err
		}
		st.format = formatFMP4AAC
		st.audioType = "aac"
		st.mimeType = "audio/aac"
		st.aac = cfg
		return st, nil
	}

	// Probe first segment to detect ADTS AAC, MP3, or MPEG-TS.
	seg0, err := s.fetchBytesWithRetry(ctx, pl.segments[0], headers)
	if err != nil {
		return nil, fmt.Errorf("fetch first segment: %w", err)
	}
	st.firstSeg = seg0

	switch {
	case looksLikeMPEGTS(seg0):
		pid, audioType, err := probeMPEGTSAudio(seg0)
		if err != nil {
			return nil, err
		}
		st.format = formatMPEGTS
		st.tsAudioPID = pid
		st.audioType = audioType
		if audioType == "mp3" {
			st.mimeType = "audio/mpeg"
		} else {
			st.mimeType = "audio/aac"
		}
	case looksLikeADTS(seg0):
		st.format = formatADTS
		st.audioType = "aac"
		st.mimeType = "audio/aac"
	case looksLikeMP3(seg0):
		st.format = formatMP3
		st.audioType = "mp3"
		st.mimeType = "audio/mpeg"
	default:
		return nil, errors.New("unsupported HLS segment format")
	}

	return st, nil
}

func randomID() string {
	var b [12]byte
	_, _ = rand.Read(b[:])
	return hex.EncodeToString(b[:])
}

// ---------------------------------------------------------------------------
// ISO-BMFF (fMP4) -> ADTS AAC

type mp4Box struct {
	typ     string
	offset  int
	headLen int
	size    int
	body    []byte
}

func iterMP4Boxes(b []byte) []mp4Box {
	var out []mp4Box
	off := 0
	for off+8 <= len(b) {
		sz := int(binary.BigEndian.Uint32(b[off:]))
		head := 8
		typ := string(b[off+4 : off+8])
		if sz == 0 {
			sz = len(b) - off
		} else if sz == 1 {
			if off+16 > len(b) {
				break
			}
			sz = int(binary.BigEndian.Uint64(b[off+8:]))
			head = 16
		}
		if sz < head || off+sz > len(b) {
			break
		}
		out = append(out, mp4Box{
			typ:     typ,
			offset:  off,
			headLen: head,
			size:    sz,
			body:    b[off+head : off+sz],
		})
		off += sz
	}
	return out
}

func findMP4Child(b []byte, path ...string) []byte {
	cur := b
	for _, want := range path {
		found := false
		for _, box := range iterMP4Boxes(cur) {
			if box.typ == want {
				cur = box.body
				found = true
				break
			}
		}
		if !found {
			return nil
		}
	}
	return cur
}

func parseInitMP4(data []byte) (aacConfig, error) {
	moov := findMP4Child(data, "moov")
	if moov == nil {
		return aacConfig{}, errors.New("fmp4: missing moov box")
	}

	var cfg aacConfig
	foundAudio := false

	for _, box := range iterMP4Boxes(moov) {
		if box.typ != "trak" {
			continue
		}
		hdlr := findMP4Child(box.body, "mdia", "hdlr")
		if len(hdlr) < 12 || string(hdlr[8:12]) != "soun" {
			continue
		}
		tkhd := findMP4Child(box.body, "tkhd")
		if len(tkhd) >= 24 {
			if tkhd[0] == 1 && len(tkhd) >= 28 {
				cfg.trackID = binary.BigEndian.Uint32(tkhd[20:24])
			} else {
				cfg.trackID = binary.BigEndian.Uint32(tkhd[12:16])
			}
		}
		stsd := findMP4Child(box.body, "mdia", "minf", "stbl", "stsd")
		if len(stsd) < 16 {
			continue
		}
		// stsd: 4 bytes version/flags + 4 bytes entry count, followed by sample entry boxes.
		for _, entry := range iterMP4Boxes(stsd[8:]) {
			if entry.typ != "mp4a" || len(entry.body) < 28 {
				continue
			}
			// AudioSampleEntry body has 28 bytes of fixed fields before child boxes (esds, ...).
			esds := findMP4Child(entry.body[28:], "esds")
			if esds == nil {
				continue
			}
			asc, err := extractAudioSpecificConfig(esds)
			if err != nil {
				return aacConfig{}, err
			}
			aot, freqIdx, chCfg, err := parseAudioSpecificConfig(asc)
			if err != nil {
				return aacConfig{}, err
			}
			cfg.audioObjectType = aot
			cfg.freqIndex = freqIdx
			cfg.channelConfig = chCfg
			foundAudio = true
			break
		}
		if foundAudio {
			break
		}
	}

	if !foundAudio {
		return aacConfig{}, errors.New("fmp4: no supported AAC audio track found")
	}

	// Read default sample size from moov/mvex/trex when present.
	if mvex := findMP4Child(moov, "mvex"); mvex != nil {
		for _, box := range iterMP4Boxes(mvex) {
			if box.typ == "trex" && len(box.body) >= 24 {
				tid := binary.BigEndian.Uint32(box.body[4:8])
				if cfg.trackID == 0 || tid == cfg.trackID {
					cfg.defaultSampleSz = binary.BigEndian.Uint32(box.body[16:20])
					break
				}
			}
		}
	}

	return cfg, nil
}

// extractAudioSpecificConfig walks ISO 14496-1 descriptors inside an esds box
// (after its 4-byte FullBox version/flags) to extract tag 0x05 (DecoderSpecificInfo).
func extractAudioSpecificConfig(esds []byte) ([]byte, error) {
	if len(esds) < 6 {
		return nil, errors.New("fmp4: short esds box")
	}
	b := esds[4:] // skip version + flags
	readDesc := func(in []byte) (tag byte, payload []byte, rest []byte, ok bool) {
		if len(in) < 2 {
			return 0, nil, nil, false
		}
		tag = in[0]
		pos := 1
		size := 0
		for i := 0; i < 4 && pos < len(in); i++ {
			c := in[pos]
			pos++
			size = (size << 7) | int(c&0x7f)
			if c&0x80 == 0 {
				break
			}
		}
		if pos+size > len(in) {
			size = len(in) - pos
		}
		return tag, in[pos : pos+size], in[pos+size:], true
	}

	var walk func([]byte) []byte
	walk = func(in []byte) []byte {
		for len(in) >= 2 {
			tag, payload, rest, ok := readDesc(in)
			if !ok {
				break
			}
			switch tag {
			case 0x03: // ES_Descriptor
				if len(payload) >= 3 {
					flags := payload[2]
					off := 3
					if flags&0x80 != 0 {
						off += 2
					}
					if flags&0x40 != 0 && off < len(payload) {
						off += 1 + int(payload[off])
					}
					if flags&0x20 != 0 {
						off += 2
					}
					if off < len(payload) {
						if asc := walk(payload[off:]); asc != nil {
							return asc
						}
					}
				}
			case 0x04: // DecoderConfigDescriptor
				if len(payload) > 13 {
					if asc := walk(payload[13:]); asc != nil {
						return asc
					}
				}
			case 0x05: // DecoderSpecificInfo -> AudioSpecificConfig
				if len(payload) >= 2 {
					return payload
				}
			}
			in = rest
		}
		return nil
	}

	asc := walk(b)
	if len(asc) < 2 {
		return nil, errors.New("fmp4: missing AudioSpecificConfig in esds")
	}
	return asc, nil
}

func parseAudioSpecificConfig(asc []byte) (aot, freqIdx, chCfg byte, err error) {
	if len(asc) < 2 {
		return 0, 0, 0, errors.New("fmp4: short AudioSpecificConfig")
	}
	aot = asc[0] >> 3
	freqIdx = ((asc[0] & 0x07) << 1) | (asc[1] >> 7)
	chCfg = (asc[1] >> 3) & 0x0f
	if aot != 2 {
		return 0, 0, 0, fmt.Errorf("fmp4: unsupported AAC object type %d", aot)
	}
	if freqIdx > 12 {
		return 0, 0, 0, fmt.Errorf("fmp4: unsupported AAC sample rate index %d", freqIdx)
	}
	if chCfg == 0 || chCfg > 7 {
		return 0, 0, 0, fmt.Errorf("fmp4: unsupported AAC channel config %d", chCfg)
	}
	return aot, freqIdx, chCfg, nil
}

func writeADTSHeader(dst []byte, cfg aacConfig, frameLen int) {
	fullLen := frameLen + 7
	profile := cfg.audioObjectType - 1 // AAC-LC (2) -> ADTS profile 1
	dst[0] = 0xff
	dst[1] = 0xf1 // MPEG-4, Layer 0, no CRC
	dst[2] = (profile << 6) | ((cfg.freqIndex & 0x0f) << 2) | ((cfg.channelConfig >> 2) & 0x01)
	dst[3] = ((cfg.channelConfig & 0x03) << 6) | byte((fullLen>>11)&0x03)
	dst[4] = byte((fullLen >> 3) & 0xff)
	dst[5] = byte(((fullLen & 0x07) << 5) | 0x1f)
	dst[6] = 0xfc
}

func fmp4SegmentToADTS(seg []byte, cfg aacConfig) ([]byte, error) {
	var out bytes.Buffer
	out.Grow(len(seg) + 2048)

	var hdr [7]byte
	for _, box := range iterMP4Boxes(seg) {
		if box.typ != "moof" {
			continue
		}
		for _, traf := range iterMP4Boxes(box.body) {
			if traf.typ != "traf" {
				continue
			}
			tfhd := findMP4Child(traf.body, "tfhd")
			if len(tfhd) < 8 {
				continue
			}
			tid := binary.BigEndian.Uint32(tfhd[4:8])
			if cfg.trackID != 0 && tid != cfg.trackID {
				continue
			}
			tfFlags := binary.BigEndian.Uint32(tfhd[:4]) & 0xffffff
			base := int64(box.offset)
			defSize := cfg.defaultSampleSz
			pos := 8
			if tfFlags&0x000001 != 0 && pos+8 <= len(tfhd) {
				base = int64(binary.BigEndian.Uint64(tfhd[pos : pos+8]))
				pos += 8
			}
			if tfFlags&0x000002 != 0 {
				pos += 4 // sample_description_index
			}
			if tfFlags&0x000008 != 0 {
				pos += 4 // default_sample_duration
			}
			if tfFlags&0x000010 != 0 && pos+4 <= len(tfhd) {
				defSize = binary.BigEndian.Uint32(tfhd[pos : pos+4])
				pos += 4
			}

			at := base
			for _, trunBox := range iterMP4Boxes(traf.body) {
				if trunBox.typ != "trun" {
					continue
				}
				trun := trunBox.body
				if len(trun) < 8 {
					return nil, errors.New("fmp4: short trun box")
				}
				flags := binary.BigEndian.Uint32(trun[:4]) & 0xffffff
				count := int(binary.BigEndian.Uint32(trun[4:8]))
				p := 8
				if flags&0x000001 != 0 {
					if p+4 > len(trun) {
						return nil, errors.New("fmp4: truncated trun data_offset")
					}
					at = base + int64(int32(binary.BigEndian.Uint32(trun[p:p+4])))
					p += 4
				}
				if flags&0x000004 != 0 {
					p += 4 // first_sample_flags
				}
				for i := 0; i < count; i++ {
					if flags&0x000100 != 0 {
						p += 4 // sample_duration
					}
					sampleSize := int(defSize)
					if flags&0x000200 != 0 {
						if p+4 > len(trun) {
							return nil, errors.New("fmp4: truncated trun sample_size")
						}
						sampleSize = int(binary.BigEndian.Uint32(trun[p : p+4]))
						p += 4
					}
					if flags&0x000400 != 0 {
						p += 4 // sample_flags
					}
					if flags&0x000800 != 0 {
						p += 4 // sample_composition_time_offset
					}
					if sampleSize <= 0 || at < 0 || int(at)+sampleSize > len(seg) {
						return nil, errors.New("fmp4: sample out of segment bounds")
					}
					writeADTSHeader(hdr[:], cfg, sampleSize)
					out.Write(hdr[:])
					out.Write(seg[at : int(at)+sampleSize])
					at += int64(sampleSize)
				}
			}
		}
	}

	return out.Bytes(), nil
}

// ---------------------------------------------------------------------------
// Segment sniffing & MPEG-TS audio demuxing

func looksLikeADTS(b []byte) bool {
	if len(b) < 7 {
		return false
	}
	return b[0] == 0xff && (b[1]&0xf6) == 0xf0 && ((b[2]>>2)&0x0f) <= 12
}

func looksLikeMP3(b []byte) bool {
	if len(b) >= 3 && string(b[:3]) == "ID3" {
		return true
	}
	if len(b) >= 2 && b[0] == 0xff && (b[1]&0xe0) == 0xe0 && (b[1]&0x06) != 0 {
		return true
	}
	return false
}

func looksLikeMPEGTS(b []byte) bool {
	if len(b) < 188 || b[0] != 0x47 {
		return false
	}
	if len(b) >= 376 {
		return b[188] == 0x47
	}
	return true
}

func probeMPEGTSAudio(seg []byte) (uint16, string, error) {
	var pmtPID uint16
	for off := 0; off+188 <= len(seg); off += 188 {
		pkt := seg[off : off+188]
		if pkt[0] != 0x47 {
			continue
		}
		pid := uint16(pkt[1]&0x1f)<<8 | uint16(pkt[2])
		payload := tsPayload(pkt)
		if len(payload) == 0 {
			continue
		}
		pusi := pkt[1]&0x40 != 0

		if pid == 0 && pusi && len(payload) > 1 {
			ptr := int(payload[0])
			sec := payload[1+ptr:]
			if len(sec) >= 12 && sec[0] == 0x00 {
				secLen := int(sec[1]&0x0f)<<8 | int(sec[2])
				end := min(len(sec), 3+secLen-4)
				for p := 8; p+4 <= end; p += 4 {
					prog := binary.BigEndian.Uint16(sec[p : p+2])
					if prog != 0 {
						pmtPID = uint16(sec[p+2]&0x1f)<<8 | uint16(sec[p+3])
						break
					}
				}
			}
		} else if pmtPID != 0 && pid == pmtPID && pusi && len(payload) > 1 {
			ptr := int(payload[0])
			sec := payload[1+ptr:]
			if len(sec) >= 16 && sec[0] == 0x02 {
				secLen := int(sec[1]&0x0f)<<8 | int(sec[2])
				progInfoLen := int(sec[10]&0x0f)<<8 | int(sec[11])
				p := 12 + progInfoLen
				end := min(len(sec), 3+secLen-4)
				for p+5 <= end {
					streamType := sec[p]
					esPID := uint16(sec[p+1]&0x1f)<<8 | uint16(sec[p+2])
					esInfoLen := int(sec[p+3]&0x0f)<<8 | int(sec[p+4])
					p += 5 + esInfoLen
					switch streamType {
					case 0x0f: // ADTS AAC
						return esPID, "aac", nil
					case 0x03, 0x04: // MPEG-1 / MPEG-2 Audio (MP3)
						return esPID, "mp3", nil
					}
				}
			}
		}
	}
	return 0, "", errors.New("mpegts: no supported AAC or MP3 audio stream found")
}

func tsPayload(pkt []byte) []byte {
	afc := (pkt[3] >> 4) & 0x03
	if afc == 0 || afc == 2 {
		return nil
	}
	pos := 4
	if afc == 3 {
		if pos >= len(pkt) {
			return nil
		}
		pos += 1 + int(pkt[pos])
	}
	if pos >= len(pkt) {
		return nil
	}
	return pkt[pos:]
}

type tsAudioDemuxer struct {
	pid    uint16
	pesBuf bytes.Buffer
	hasPES bool
}

func (d *tsAudioDemuxer) feed(seg []byte) []byte {
	var out bytes.Buffer
	for off := 0; off+188 <= len(seg); off += 188 {
		pkt := seg[off : off+188]
		if pkt[0] != 0x47 {
			continue
		}
		pid := uint16(pkt[1]&0x1f)<<8 | uint16(pkt[2])
		if pid != d.pid {
			continue
		}
		payload := tsPayload(pkt)
		if len(payload) == 0 {
			continue
		}
		if pkt[1]&0x40 != 0 {
			if d.hasPES {
				out.Write(extractPESPayload(d.pesBuf.Bytes()))
				d.pesBuf.Reset()
			}
			d.hasPES = true
		}
		if d.hasPES {
			d.pesBuf.Write(payload)
		}
	}
	return out.Bytes()
}

func (d *tsAudioDemuxer) flush() []byte {
	if !d.hasPES || d.pesBuf.Len() == 0 {
		return nil
	}
	data := extractPESPayload(d.pesBuf.Bytes())
	d.pesBuf.Reset()
	d.hasPES = false
	return data
}

func extractPESPayload(pes []byte) []byte {
	if len(pes) < 9 || pes[0] != 0x00 || pes[1] != 0x00 || pes[2] != 0x01 {
		return nil
	}
	hdrLen := int(pes[8])
	start := 9 + hdrLen
	if start >= len(pes) {
		return nil
	}
	return pes[start:]
}
