// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 SoundGo contributors

package main

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
)

func makeBox(typ string, body []byte) []byte {
	out := make([]byte, 8+len(body))
	binary.BigEndian.PutUint32(out[0:4], uint32(len(out)))
	copy(out[4:8], typ)
	copy(out[8:], body)
	return out
}

func makeSyntheticInitMP4(trackID uint32, aot, freqIdx, chCfg byte) []byte {
	// AudioSpecificConfig: 5 bits AOT, 4 bits freqIdx, 4 bits chCfg, 3 bits 0.
	asc := []byte{
		(aot << 3) | (freqIdx >> 1),
		((freqIdx & 1) << 7) | (chCfg << 3),
	}
	// Tag 0x05 (DecoderSpecificInfo)
	dsi := append([]byte{0x05, byte(len(asc))}, asc...)
	// Tag 0x04 (DecoderConfigDescriptor): 13 header bytes + dsi
	dcdPayload := append(make([]byte, 13), dsi...)
	dcd := append([]byte{0x04, byte(len(dcdPayload))}, dcdPayload...)
	// Tag 0x03 (ES_Descriptor): 3 header bytes + dcd
	esdPayload := append([]byte{0x00, 0x01, 0x00}, dcd...)
	esd := append([]byte{0x03, byte(len(esdPayload))}, esdPayload...)

	esds := makeBox("esds", append([]byte{0, 0, 0, 0}, esd...))
	mp4aBody := append(make([]byte, 28), esds...)
	mp4a := makeBox("mp4a", mp4aBody)
	stsdBody := append([]byte{0, 0, 0, 0, 0, 0, 0, 1}, mp4a...)
	stsd := makeBox("stsd", stsdBody)
	stbl := makeBox("stbl", stsd)
	minf := makeBox("minf", stbl)
	hdlrBody := make([]byte, 12)
	copy(hdlrBody[8:12], "soun")
	hdlr := makeBox("hdlr", hdlrBody)
	mdia := makeBox("mdia", append(hdlr, minf...))

	tkhdBody := make([]byte, 24)
	binary.BigEndian.PutUint32(tkhdBody[12:16], trackID)
	tkhd := makeBox("tkhd", tkhdBody)
	trak := makeBox("trak", append(tkhd, mdia...))
	moov := makeBox("moov", trak)
	ftyp := makeBox("ftyp", []byte("isom\x00\x00\x02\x00"))
	return append(ftyp, moov...)
}

func makeSyntheticM4S(trackID uint32, frames [][]byte) []byte {
	var mdatPayload bytes.Buffer
	for _, f := range frames {
		mdatPayload.Write(f)
	}

	tfhdBody := make([]byte, 8)
	binary.BigEndian.PutUint32(tfhdBody[4:8], trackID)
	tfhd := makeBox("tfhd", tfhdBody)

	// trun with data_offset (0x000001) + sample_size (0x000200)
	trunBody := make([]byte, 12+4*len(frames))
	binary.BigEndian.PutUint32(trunBody[0:4], 0x000201)
	binary.BigEndian.PutUint32(trunBody[4:8], uint32(len(frames)))
	for i, f := range frames {
		binary.BigEndian.PutUint32(trunBody[12+4*i:16+4*i], uint32(len(f)))
	}

	// Build once to know exact moof size so data_offset points to mdat payload.
	traf := makeBox("traf", append(tfhd, makeBox("trun", trunBody)...))
	moofSize := len(makeBox("moof", traf))
	binary.BigEndian.PutUint32(trunBody[8:12], uint32(moofSize+8))

	traf = makeBox("traf", append(tfhd, makeBox("trun", trunBody)...))
	moof := makeBox("moof", traf)
	mdat := makeBox("mdat", mdatPayload.Bytes())
	return append(moof, mdat...)
}

func TestFMP4HLSToADTSStream(t *testing.T) {
	initMP4 := makeSyntheticInitMP4(1, 2, 4, 2) // AAC-LC, 44100 Hz (index 4), stereo (2)
	frame1 := []byte{0x21, 0x00, 0x49, 0x90, 0x02, 0x19, 0x00, 0x23}
	frame2 := []byte{0x21, 0x11, 0x22, 0x33, 0x44, 0x55}
	seg0 := makeSyntheticM4S(1, [][]byte{frame1})
	seg1 := makeSyntheticM4S(1, [][]byte{frame2})

	var upstream *httptest.Server
	upstream = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/playlist.m3u8":
			fmt.Fprintf(w, "#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-MAP:URI=\"%s/init.mp4\"\n#EXTINF:10.0,\n%s/seg0.m4s\n#EXTINF:10.0,\n%s/seg1.m4s\n", upstream.URL, upstream.URL, upstream.URL)
		case "/init.mp4":
			_, _ = w.Write(initMP4)
		case "/seg0.m4s":
			_, _ = w.Write(seg0)
		case "/seg1.m4s":
			_, _ = w.Write(seg1)
		default:
			http.NotFound(w, r)
		}
	}))
	defer upstream.Close()

	s := newServer(upstream.Client())
	mux := http.NewServeMux()
	mux.HandleFunc("/register", s.handleRegister)
	mux.HandleFunc("/stream/", s.handleStream)
	helperSrv := httptest.NewServer(mux)
	defer helperSrv.Close()

	regBody := fmt.Sprintf(`{"url":%q}`, upstream.URL+"/playlist.m3u8")
	resp, err := http.Post(helperSrv.URL+"/register", "application/json", bytes.NewBufferString(regBody))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(resp.Body)
		t.Fatalf("register status %d: %s", resp.StatusCode, b)
	}

	var reg registerResponse
	if err := json.NewDecoder(resp.Body).Decode(&reg); err != nil {
		t.Fatal(err)
	}
	if reg.Type != "aac" {
		t.Fatalf("expected type aac, got %q", reg.Type)
	}

	streamResp, err := http.Get(reg.URL)
	if err != nil {
		t.Fatal(err)
	}
	defer streamResp.Body.Close()
	got, err := io.ReadAll(streamResp.Body)
	if err != nil {
		t.Fatal(err)
	}

	wantLen := (7 + len(frame1)) + (7 + len(frame2))
	if len(got) != wantLen {
		t.Fatalf("got %d bytes, want %d", len(got), wantLen)
	}

	// Verify ADTS frame 1 header and payload
	if !looksLikeADTS(got[:7]) {
		t.Fatalf("invalid ADTS header 1: %x", got[:7])
	}
	adtsLen1 := int(got[3]&3)<<11 | int(got[4])<<3 | int(got[5]>>5)
	if adtsLen1 != 7+len(frame1) || !bytes.Equal(got[7:adtsLen1], frame1) {
		t.Fatalf("frame 1 mismatch: len=%d payload=%x", adtsLen1, got[7:adtsLen1])
	}

	// Verify ADTS frame 2 header and payload
	rest := got[adtsLen1:]
	if !looksLikeADTS(rest[:7]) {
		t.Fatalf("invalid ADTS header 2: %x", rest[:7])
	}
	adtsLen2 := int(rest[3]&3)<<11 | int(rest[4])<<3 | int(rest[5]>>5)
	if adtsLen2 != 7+len(frame2) || !bytes.Equal(rest[7:adtsLen2], frame2) {
		t.Fatalf("frame 2 mismatch: len=%d payload=%x", adtsLen2, rest[7:adtsLen2])
	}
}

func TestMP3HLSPassthrough(t *testing.T) {
	mp3Seg0 := append([]byte("ID3\x03\x00\x00\x00\x00\x00\x00"), []byte{0xff, 0xfb, 0x90, 0x00, 1, 2, 3}...)
	mp3Seg1 := []byte{0xff, 0xfb, 0x90, 0x00, 4, 5, 6}

	var upstream *httptest.Server
	upstream = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/playlist.m3u8":
			fmt.Fprintf(w, "#EXTM3U\n#EXTINF:10.0,\nseg0.mp3\n#EXTINF:10.0,\nseg1.mp3\n")
		case "/seg0.mp3":
			_, _ = w.Write(mp3Seg0)
		case "/seg1.mp3":
			_, _ = w.Write(mp3Seg1)
		default:
			http.NotFound(w, r)
		}
	}))
	defer upstream.Close()

	s := newServer(upstream.Client())
	mux := http.NewServeMux()
	mux.HandleFunc("/register", s.handleRegister)
	mux.HandleFunc("/stream/", s.handleStream)
	helperSrv := httptest.NewServer(mux)
	defer helperSrv.Close()

	resp, err := http.Post(helperSrv.URL+"/register", "application/json", bytes.NewBufferString(fmt.Sprintf(`{"url":%q}`, upstream.URL+"/playlist.m3u8")))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var reg registerResponse
	_ = json.NewDecoder(resp.Body).Decode(&reg)
	if reg.Type != "mp3" {
		t.Fatalf("expected type mp3, got %q", reg.Type)
	}

	streamResp, err := http.Get(reg.URL)
	if err != nil {
		t.Fatal(err)
	}
	defer streamResp.Body.Close()
	got, _ := io.ReadAll(streamResp.Body)
	want := append(append([]byte(nil), mp3Seg0...), mp3Seg1...)
	if !bytes.Equal(got, want) {
		t.Fatalf("mp3 passthrough mismatch: got %x want %x", got, want)
	}
}

func TestEncryptedHLSRejected(t *testing.T) {
	pl := []byte("#EXTM3U\n#EXT-X-KEY:METHOD=SAMPLE-AES,URI=\"skd://drm\"\n#EXTINF:10.0,\nseg0.m4s\n")
	if _, err := parseM3U8("https://example.com/p.m3u8", pl); err == nil {
		t.Fatal("expected encrypted playlist to be rejected")
	}
}
