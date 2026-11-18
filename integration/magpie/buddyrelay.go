package gui

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/netip"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/yetone/magpie/internal/provider"
)

const buddyRelaySite = "https://github.com/loveApril1006/buddyrelay-desktop"

func buddyRelayExe() string {
	exe, err := os.Executable()
	if err != nil {
		return ""
	}
	parent := filepath.Dir(exe)
	if !strings.EqualFold(filepath.Base(parent), "magpie") {
		return ""
	}
	path := filepath.Join(filepath.Dir(parent), "buddyrelay.exe")
	if st, err := os.Stat(path); err == nil && st.Mode().IsRegular() {
		return path
	}
	return ""
}

func buddyRelayRoutes(mux *http.ServeMux) {
	var connect sync.Mutex
	native := func(f func(http.ResponseWriter, *http.Request, string)) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			// ownWindow sets this only on requests delivered by Wails.
			if r.Context().Value(windowSchemeKey{}) == nil {
				http.NotFound(w, r)
				return
			}
			exe := buddyRelayExe()
			if exe == "" {
				http.NotFound(w, r)
				return
			}
			f(w, r, exe)
		}
	}
	mux.HandleFunc("GET /api/buddyrelay", native(func(w http.ResponseWriter, _ *http.Request, _ string) {
		w.WriteHeader(http.StatusNoContent)
	}))
	mux.HandleFunc("POST /api/buddyrelay/open", native(func(w http.ResponseWriter, _ *http.Request, exe string) {
		cmd := exec.Command(exe, "--workbuddy")
		if err := cmd.Start(); err != nil {
			http.Error(w, "无法启动 WorkBuddy 管理", http.StatusServiceUnavailable)
			return
		}
		go cmd.Wait()
		w.WriteHeader(http.StatusNoContent)
	}))
	mux.HandleFunc("POST /api/buddyrelay/connect/{edition}", native(func(w http.ResponseWriter, r *http.Request, exe string) {
		edition := r.PathValue("edition")
		if edition != "domestic" && edition != "international" {
			http.NotFound(w, r)
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
		defer cancel()
		gateway, err := readBuddyRelayGateway(ctx, exe, edition)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		connect.Lock()
		err = saveBuddyRelayProvider(edition, gateway)
		connect.Unlock()
		if err != nil {
			http.Error(w, err.Error(), http.StatusConflict)
			return
		}
		// Use Magpie's model discovery, which also populates its model list
		// for the gateway. A relay can be configured before any accounts log in.
		loaded := false
		if p, err := provider.Find("buddyrelay-" + edition); err == nil && !p.Off {
			modelsCtx, stop := context.WithTimeout(r.Context(), 8*time.Second)
			models, err := p.Fetch(modelsCtx)
			stop()
			loaded = err == nil && len(models) > 0
		}
		writeJSON(w, map[string]bool{"modelsLoaded": loaded})
	}))
}

type buddyRelayGateway struct {
	Enabled bool
	Listen  string
	Key     string `json:"api_key"`
}

func readBuddyRelayGateway(ctx context.Context, exe, edition string) (buddyRelayGateway, error) {
	var gateways map[string]buddyRelayGateway
	data, err := exec.CommandContext(ctx, exe, "--workbuddy-gateways").Output()
	if err != nil || json.Unmarshal(data, &gateways) != nil {
		return buddyRelayGateway{}, errors.New("无法读取 WorkBuddy 反代设置")
	}
	cfg := gateways[edition]
	if !cfg.Enabled {
		return buddyRelayGateway{}, errors.New("请先在 WorkBuddy 管理中启用这一版本的 API 反代")
	}
	return cfg, nil
}

func buddyRelayBaseURL(listen string) (string, error) {
	addr, err := netip.ParseAddrPort(strings.TrimSpace(listen))
	if err != nil || addr.Port() == 0 {
		return "", errors.New("请在 WorkBuddy 使用固定端口的本机监听地址")
	}
	ip := addr.Addr().Unmap()
	if ip.IsUnspecified() {
		if ip.Is4() {
			ip = netip.MustParseAddr("127.0.0.1")
		} else {
			ip = netip.IPv6Loopback()
		}
	}
	if !ip.IsLoopback() || ip.Zone() != "" {
		return "", errors.New("请将 WorkBuddy 反代绑定到本机回环地址后再接入")
	}
	return "http://" + netip.AddrPortFrom(ip, addr.Port()).String() + "/v1", nil
}

func saveBuddyRelayProvider(edition string, cfg buddyRelayGateway) error {
	base, err := buddyRelayBaseURL(cfg.Listen)
	if err != nil {
		return err
	}
	id := "buddyrelay-" + edition
	name := "WorkBuddy · BuddyRelay"
	if edition == "international" {
		name = "WorkBuddy AI · BuddyRelay"
	}
	p := provider.Provider{ID: id, Name: name, Website: buddyRelaySite}
	if old, _ := provider.Find(id); old != nil && old.ID == id {
		if old.Website != buddyRelaySite || old.Account != nil || old.Responses != "" || old.Anthropic != "" || old.Gemini != "" {
			return errors.New("Magpie 中已有同名供应商，请先重命名该供应商")
		}
		p = *old
	}
	p.Chat = base
	p.Key = strings.TrimSpace(cfg.Key)
	if p.Key == "" {
		// A custom provider expects a bearer value. WorkBuddy accepts any
		// value when the user left its local gateway key empty.
		p.Key = "buddyrelay-local"
	}
	p.Proxy = "direct"
	p.AccountProxies = nil
	p.Resolve = nil
	if err := provider.Save(p); err != nil {
		return errors.New("无法保存 Magpie 供应商，请检查供应商设置")
	}
	return nil
}
