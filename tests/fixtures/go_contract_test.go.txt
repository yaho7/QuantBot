package main

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"testing"
)

func TestContractRequest(t *testing.T) {
	payload, err := io.ReadAll(os.Stdin)
	if err != nil {
		t.Fatal("cannot read test payload")
	}
	data, err := request(os.Getenv("QB_METHOD"), os.Getenv("QB_PATH"), os.Getenv("QB_ENDPOINT"),
		os.Getenv("QB_TOKEN"), os.Getenv("QB_SESSION"), payload)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		t.FailNow()
	}
	encoded, err := json.Marshal(data)
	if err != nil {
		t.Fatal("cannot encode test response")
	}
	fmt.Println(string(encoded))
}
