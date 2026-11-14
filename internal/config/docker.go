package config

import (
	"encoding/binary"
	"errors"
	"net/netip"
	"os"
	"strconv"
	"strings"
)

func dockerGateway() (netip.Addr, error) {
	routes, err := os.ReadFile("/proc/net/route")
	if err != nil {
		return netip.Addr{}, err
	}
	for line := range strings.SplitSeq(string(routes), "\n") {
		fields := strings.Fields(line)
		if len(fields) < 4 || fields[1] != "00000000" {
			continue
		}
		flags, err := strconv.ParseUint(fields[3], 16, 32)
		if err != nil || flags&3 != 3 {
			continue
		}
		address, err := strconv.ParseUint(fields[2], 16, 32)
		if err != nil {
			return netip.Addr{}, err
		}
		var octets [4]byte
		binary.LittleEndian.PutUint32(octets[:], uint32(address))
		gateway := netip.AddrFrom4(octets)
		if !gateway.IsPrivate() {
			return netip.Addr{}, errors.New("Docker gateway must be a private IPv4 address")
		}
		return gateway, nil
	}
	return netip.Addr{}, errors.New("Docker bridge gateway not found")
}
