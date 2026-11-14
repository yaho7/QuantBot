package server

import (
	"encoding/json"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/yaho7/QuantBot/internal/command"
	"github.com/yaho7/QuantBot/internal/config"
	"github.com/yaho7/QuantBot/internal/storage"
)

func TestLayoutRevisionAndPresentationAuthority(t *testing.T) {
	ctx := t.Context()
	stores, err := storage.Open(ctx, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = stores.Close() })
	handler := testRoutes(t, stores, config.Config{}, command.New(stores.Control, ctx, 0, nil))
	const origin = "http://127.0.0.1:23456"
	session, cookie := parseSession(t, requestAuth(t, handler, "POST", "/setup",
		`{"username":"admin","password":"paper-test-password"}`, origin, nil, "", 200))
	if _, err := stores.Control.Write.ExecContext(ctx, `
		INSERT INTO strategies(id,name,group_name,mode,created_at) VALUES('paper','Paper','','paper',1);
		INSERT INTO control_registries(strategy_id,revision,instance_id,boot_id,updated_at) VALUES('paper',1,'worker','boot',1);
		INSERT INTO control_definitions(strategy_id,control_id,definition) VALUES('paper','status',
			'{"id":"status","title":"Status","kind":"status","readOnly":true}');
	`); err != nil {
		t.Fatal(err)
	}
	send := func(method, body string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(method, origin+"/api/v1/layouts/workbench", strings.NewReader(body))
		req.RemoteAddr = "127.0.0.1:10000"
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Origin", origin)
		req.Header.Set("X-CSRF-Token", session.CSRF)
		req.AddCookie(cookie)
		res := httptest.NewRecorder()
		handler.ServeHTTP(res, req)
		return res
	}
	const first = `{"version":1,"revision":0,"widgets":[{"id":"control-widget","type":"control","strategyId":"paper","controlId":"status","size":"small","label":"Readonly status","color":"#224466","description":true,"detailed":true}]}`
	if res := send("PUT", first); res.Code != 200 {
		t.Fatalf("save failed: %d %s", res.Code, res.Body)
	}
	if res := send("PUT", first); res.Code != 200 || !strings.Contains(res.Body.String(), `"revision":1`) {
		t.Fatalf("retry failed: %d %s", res.Code, res.Body)
	}
	var actual struct {
		Version  int
		Revision int
		Widgets  []json.RawMessage
	}
	if res := send("GET", ""); res.Code != 200 || json.Unmarshal(res.Body.Bytes(), &actual) != nil || actual.Revision != 1 || len(actual.Widgets) != 1 {
		t.Fatalf("invalid persisted layout: %s", res.Body)
	}
	if res := send("PUT", strings.Replace(first, `"size":"small"`, `"size":"small","readOnly":false`, 1)); res.Code != 400 {
		t.Fatalf("layout accepted an authority field: %d", res.Code)
	}

	var racers sync.WaitGroup
	results := make(chan int, 2)
	for _, label := range []string{"Window A", "Window B"} {
		body := strings.Replace(strings.Replace(first, `"revision":0`, `"revision":1`, 1), "Readonly status", label, 1)
		racers.Go(func() { results <- send("PUT", body).Code })
	}
	racers.Wait()
	close(results)
	counts := map[int]int{}
	for status := range results {
		counts[status]++
	}
	if counts[200] != 1 || counts[409] != 1 {
		t.Fatalf("concurrent layout saves: %v", counts)
	}
	if _, err := stores.Control.Write.ExecContext(ctx, "DELETE FROM control_definitions WHERE strategy_id='paper'"); err != nil {
		t.Fatal(err)
	}
	res := send("PUT", strings.Replace(strings.Replace(first, `"revision":0`, `"revision":2`, 1), `"size":"small"`, `"size":"large","hidden":true`, 1))
	if res.Code != 200 || !strings.Contains(res.Body.String(), `"hidden":true`) {
		t.Fatalf("could not edit a saved slot after capability removal: %d %s", res.Code, res.Body)
	}
	if res := send("PUT", strings.Replace(strings.Replace(first, `"revision":0`, `"revision":3`, 1), "control-widget", "new-widget", 1)); res.Code != 400 {
		t.Fatalf("layout created a new widget with a missing source: %d", res.Code)
	}

}
