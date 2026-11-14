package httpapi

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"net/http"
	"strings"
	"unicode/utf8"
)

func JSON(w http.ResponseWriter, status int, data any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(data)
}

func Error(w http.ResponseWriter, status int, code, message string) {
	JSON(w, status, map[string]string{"code": code, "message": message})
}

func ReadJSON(w http.ResponseWriter, r *http.Request, target any, limit int64) bool {
	contentType, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil || contentType != "application/json" {
		Error(w, http.StatusUnsupportedMediaType, "content_type", "Expected application/json")
		return false
	}
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, limit))
	var tooLarge *http.MaxBytesError
	if errors.As(err, &tooLarge) {
		Error(w, http.StatusRequestEntityTooLarge, "body_too_large", "Request body exceeds limit")
		return false
	}
	if err == nil {
		err = Decode(body, target)
	}
	if err != nil {
		Error(w, http.StatusBadRequest, "invalid_json", err.Error())
		return false
	}
	return true
}

func Decode(body []byte, target any) error {
	if !utf8.Valid(body) {
		return errors.New("invalid UTF-8 in JSON")
	}
	shape := json.NewDecoder(bytes.NewReader(body))
	shape.UseNumber()
	if err := checkValue(shape, 0); err != nil {
		return err
	}
	if _, err := shape.Token(); !errors.Is(err, io.EOF) {
		return errors.New("expected one JSON value")
	}
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.DisallowUnknownFields()
	decoder.UseNumber()
	return decoder.Decode(target)
}

func checkValue(decoder *json.Decoder, depth int) error {
	if depth > 64 {
		return errors.New("JSON nesting exceeds limit")
	}
	token, err := decoder.Token()
	if err != nil {
		return err
	}
	delimiter, compound := token.(json.Delim)
	if !compound {
		if depth == 0 && token == nil {
			return errors.New("request cannot be null")
		}
		return nil
	}
	keys := make(map[string]struct{})
	for decoder.More() {
		if delimiter == '{' {
			keyToken, err := decoder.Token()
			if err != nil {
				return err
			}
			key := keyToken.(string)
			folded := strings.ToLower(key)
			if _, exists := keys[folded]; exists {
				return fmt.Errorf("duplicate JSON key %q", key)
			}
			keys[folded] = struct{}{}
		}
		if err := checkValue(decoder, depth+1); err != nil {
			return err
		}
	}
	_, err = decoder.Token()
	return err
}
