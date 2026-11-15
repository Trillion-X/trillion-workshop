import importlib.util
import io
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location('download', Path(__file__).parent.parent / 'do-work/publish-download.py')
download = importlib.util.module_from_spec(spec)
spec.loader.exec_module(download)


class PointerRecovery(unittest.TestCase):
    def check_failed_default(self, previous):
        with tempfile.TemporaryDirectory() as root:
            folder = Path(root)
            if previous is not None:
                (folder / 'App.dmg').symlink_to(previous)
            (folder / '.default-download.conf').write_text('previous redirect')
            replace = download.os.replace

            def fail_default(source, target):
                if Path(target).name == '.default-download.conf':
                    raise OSError('injected redirect failure')
                return replace(source, target)

            with patch.object(download.os, 'replace', side_effect=fail_default):
                with self.assertRaises(OSError):
                    download.publish(folder, 'App-2.dmg', 'App.dmg', 3, io.BytesIO(b'abc'))
            if previous is None:
                self.assertFalse((folder / 'App.dmg').is_symlink())
            else:
                self.assertEqual(download.os.readlink(folder / 'App.dmg'), previous)
            self.assertEqual((folder / '.default-download.conf').read_text(), 'previous redirect')
            self.assertEqual((folder / 'App-2.dmg').read_bytes(), b'abc')
            self.assertFalse(any(path.is_dir() for path in folder.iterdir()))

    def test_redirect_failure_restores_existing_pointer(self):
        self.check_failed_default('Old.dmg')

    def test_redirect_failure_removes_new_pointer(self):
        self.check_failed_default(None)

    def test_failed_recovery_reports_unknown_outcome(self):
        with tempfile.TemporaryDirectory() as root:
            folder = Path(root)
            (folder / 'App.dmg').symlink_to('Old.dmg')
            replace = download.os.replace
            calls = []

            def fail_after_pointer(source, target):
                calls.append(Path(target).name)
                if len(calls) > 1:
                    raise OSError('injected redirect and recovery failure')
                return replace(source, target)

            with patch.object(download.os, 'replace', side_effect=fail_after_pointer):
                with self.assertRaisesRegex(RuntimeError, 'outcome is unknown'):
                    download.publish(folder, 'App-2.dmg', 'App.dmg', 3, io.BytesIO(b'abc'))
            self.assertEqual(download.os.readlink(folder / 'App.dmg'), 'App-2.dmg')

    def test_public_pointer_cannot_overwrite_a_retained_regular_file(self):
        with tempfile.TemporaryDirectory() as root:
            folder = Path(root)
            (folder / 'App.dmg').write_bytes(b'original immutable bytes')
            with self.assertRaisesRegex(ValueError, 'cannot replace a retained file'):
                download.publish(folder, 'App-2.dmg', 'App.dmg', 3, io.BytesIO(b'abc'))
            self.assertEqual((folder / 'App.dmg').read_bytes(), b'original immutable bytes')
            self.assertFalse((folder / 'App-2.dmg').exists())


if __name__ == '__main__':
    unittest.main()
