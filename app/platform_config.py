"""Host-specific storage and the notebook's Beijing time zone."""
import argparse
import os
from pathlib import Path
import sys
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError


def default_data_dir():
    if sys.platform == 'win32':
        local = os.environ.get('LOCALAPPDATA')
        base = Path(local) if local else Path.home()/'AppData'/'Local'
        return base/'Lab Note'
    return Path.home()/'Library'/'Application Support'/'Culture Notes Share'


def beijing_timezone():
    try:
        return ZoneInfo('Asia/Shanghai')
    except ZoneInfoNotFoundError:
        with (Path(__file__).parent/'tzdata'/'Shanghai.tzif').open('rb') as source:
            return ZoneInfo.from_file(source, key='Asia/Shanghai')


TZ = beijing_timezone()

def port_value(value):
    if value.lower()=='auto':
        return None
    if value.isascii() and value.isdecimal() and len(value)<=5 and 1<=int(value)<=65535:
        return int(value)
    raise argparse.ArgumentTypeError('请输入 auto 或 1–65535 之间的端口号')
