package auth

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"regexp"
	"strings"

	"golang.org/x/crypto/argon2"
)

var usernamePattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{2,47}$`)

func secret() string {
	var value [32]byte
	rand.Read(value[:])
	return base64.RawURLEncoding.EncodeToString(value[:])
}

func Digest(secret string) string {
	sum := sha256.Sum256([]byte(secret))
	return hex.EncodeToString(sum[:])
}

func passwordHash(password string) string {
	var salt [16]byte
	rand.Read(salt[:])
	return encodePassword(password, salt[:])
}

func encodePassword(password string, salt []byte) string {
	hash := argon2.IDKey([]byte(password), salt, 3, 64*1024, 2, 32)
	return "argon2id-v1$" + hex.EncodeToString(salt) + "$" + hex.EncodeToString(hash)
}

func verifyPassword(encoded, password string) bool {
	fields := strings.Split(encoded, "$")
	if len(fields) != 3 || fields[0] != "argon2id-v1" {
		return false
	}
	salt, err := hex.DecodeString(fields[1])
	if err != nil || len(salt) != 16 {
		return false
	}
	return same(encoded, encodePassword(password, salt))
}

func same(first, second string) bool {
	return subtle.ConstantTimeCompare([]byte(first), []byte(second)) == 1
}

func validPassword(password string) bool {
	return len(password) >= 8 && len(password) <= 256
}
