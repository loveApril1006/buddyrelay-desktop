package gui

import (
	"net"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/yetone/magpie/internal/provider"
)

func TestBuddyRelayDesktopOnly(t *testing.T) {
	mux := http.NewServeMux()
	buddyRelayRoutes(mux)
	for _, path := range []string{"/api/buddyrelay/open", "/api/buddyrelay/connect/domestic"} {
		r := httptest.NewRequest(http.MethodPost, "http://wails.localhost"+path, nil)
		r.Header.Set("Origin", "http://wails.localhost")
		w := httptest.NewRecorder()
		mux.ServeHTTP(w, r)
		if w.Code != http.StatusNotFound {
			t.Fatalf("%s: network returned %d", path, w.Code)
		}
	}
}

func TestBuddyRelayProviderLoadsModels(t *testing.T) {
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	const key = "sample-local-gateway-key"
	relay := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/models" || r.Header.Get("Authorization") != "Bearer "+key {
			http.Error(w, "wrong path or key", http.StatusUnauthorized)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"object":"list","data":[{"id":"buddyrelay-smoke","object":"model"}]}`))
	}))
	defer relay.Close()

	listen := relay.Listener.Addr().(*net.TCPAddr).String()
	cfg := buddyRelayGateway{Enabled: true, Listen: listen, Key: key}
	for range 2 {
		if err := saveBuddyRelayProvider("domestic", cfg); err != nil {
			t.Fatal(err)
		}
	}
	p, err := provider.Find("buddyrelay-domestic")
	if err != nil {
		t.Fatal(err)
	}
	models, err := p.Fetch(t.Context())
	if err != nil || len(models) != 1 || models[0].ID != "buddyrelay-smoke" {
		t.Fatalf("model discovery: %v, %v", models, err)
	}
}

func TestBuddyRelayLoopback(t *testing.T) {
	for listen, want := range map[string]string{
		"127.0.0.1:7863": "http://127.0.0.1:7863/v1",
		"0.0.0.0:7864":   "http://127.0.0.1:7864/v1",
		"[::]:7865":     "http://[::1]:7865/v1",
		"127.0.0.1:0":  "",
		"10.0.0.1:7863": "",
		"other:7863":    "",
	} {
		got, err := buddyRelayBaseURL(listen)
		if got != want || (err != nil) != (want == "") {
			t.Errorf("%q: %q, %v; want %q", listen, got, err, want)
		}
	}
}
