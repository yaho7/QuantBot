package httpapi

import (
	"context"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"strings"
)

type peerKey struct{}

type Peer struct {
	Address netip.Addr
	Origin  string
	Secure  bool
}

type Proxies []netip.Prefix

func (proxies Proxies) IdentifyPeer(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		host, _, err := net.SplitHostPort(r.RemoteAddr)
		if err != nil {
			Error(w, http.StatusBadRequest, "invalid_peer", "Invalid peer address")
			return
		}
		addr, err := netip.ParseAddr(host)
		if err != nil {
			Error(w, http.StatusBadRequest, "invalid_peer", "Invalid peer address")
			return
		}
		addr = addr.Unmap()
		// HTTPS terminators use this only to describe the external scheme.
		// Forwarded client identity is trusted only for configured proxies.
		secure := r.TLS != nil || strings.EqualFold(strings.TrimSpace(r.Header.Get("X-Forwarded-Proto")), "https")
		for _, proxy := range proxies {
			if proxy.Contains(addr) {
				addr = proxies.clientAddress(r.Header.Get("X-Forwarded-For"), addr)
				break
			}
		}
		scheme := "http"
		if secure {
			scheme = "https"
		}
		origin := scheme + "://" + strings.ToLower(r.Host)
		peer := Peer{Address: addr, Origin: origin, Secure: secure}
		next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), peerKey{}, peer)))
	})
}

func (proxies Proxies) clientAddress(forwarded string, proxy netip.Addr) netip.Addr {
	addresses := strings.Split(forwarded, ",")
	for index := len(addresses) - 1; index >= 0; index-- {
		addr, err := netip.ParseAddr(strings.TrimSpace(addresses[index]))
		if err != nil {
			return proxy
		}
		addr = addr.Unmap()
		trusted := false
		for _, prefix := range proxies {
			trusted = trusted || prefix.Contains(addr)
		}
		if !trusted {
			return addr
		}
	}
	return proxy
}

func RequestPeer(r *http.Request) Peer {
	peer, _ := r.Context().Value(peerKey{}).(Peer)
	return peer
}

func BrowserOrigin(w http.ResponseWriter, r *http.Request) bool {
	origin := r.Header.Get("Origin")
	fetchSite := r.Header.Get("Sec-Fetch-Site")
	parsed, err := url.Parse(origin)
	peer := RequestPeer(r)
	if origin == "" || err != nil || parsed.User != nil || parsed.Path != "" || parsed.RawQuery != "" ||
		!strings.EqualFold(origin, peer.Origin) || (fetchSite != "" && fetchSite != "same-origin" && fetchSite != "none") {
		Error(w, http.StatusForbidden, "origin_required", "Expected a same-origin browser request")
		return false
	}
	return true
}
