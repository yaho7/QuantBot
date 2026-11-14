package maintenance

import "golang.org/x/sys/unix"

func publishRestore(stage, destination string) error {
	return unix.RenamexNp(stage, destination, unix.RENAME_EXCL)
}
