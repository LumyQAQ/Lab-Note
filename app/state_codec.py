"""Read historical SQLite states stored as JSON text or a versioned zlib BLOB."""
import json
import zlib

ZLIB_PREFIX = b'ZLIB1:'


def pack_state_blob(value):
    raw = value.encode('utf-8') if isinstance(value, str) else bytes(value)
    if raw.startswith(ZLIB_PREFIX):
        return raw
    return ZLIB_PREFIX + zlib.compress(raw)


def unpack_state_blob(value):
    if isinstance(value, str):
        return value
    raw = bytes(value)
    if raw.startswith(ZLIB_PREFIX):
        raw = zlib.decompress(raw[len(ZLIB_PREFIX):])
    return raw.decode('utf-8')


def loads_state_blob(value):
    return json.loads(unpack_state_blob(value))
