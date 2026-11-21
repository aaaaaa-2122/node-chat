#!/usr/bin/env python3
"""清理延迟测试脚本留下的 probe 账号与消息。"""
import json
import os
import shutil
import time

BASE = '/var/lib/node-chat'
ts = time.strftime('%Y%m%d%H%M%S')


def is_probe(name):
    return str(name).lower().startswith('probe')


# 先备份，出问题可以直接回滚
for f in ('rooms.json', 'users.json', 'dms.json'):
    p = os.path.join(BASE, f)
    if os.path.exists(p):
        shutil.copy(p, f'{p}.bak-probe-{ts}')

report = {}

rooms = json.load(open(os.path.join(BASE, 'rooms.json'), encoding='utf-8'))
rm_msgs = rm_mem = 0
for name, r in rooms.items():
    h = r.get('history', [])
    keep = [m for m in h if not str(m.get('text', '')).startswith('probe-')]
    rm_msgs += len(h) - len(keep)
    r['history'] = keep
    mem = r.get('members', [])
    keepm = [m for m in mem if not is_probe(m)]
    rm_mem += len(mem) - len(keepm)
    r['members'] = keepm
report['messages_removed'] = rm_msgs
report['members_removed'] = rm_mem

users = json.load(open(os.path.join(BASE, 'users.json'), encoding='utf-8'))
pk = [k for k in users if is_probe(k)]
for k in pk:
    del users[k]
report['users_removed'] = len(pk)

dms = json.load(open(os.path.join(BASE, 'dms.json'), encoding='utf-8'))
dk = [k for k in dms if any(is_probe(x) for x in k.split('\x00'))]
for k in dk:
    del dms[k]
report['dms_removed'] = len(dk)


def dump(path, obj):
    tmp = path + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(obj, f, ensure_ascii=False, indent=2)
    os.replace(tmp, path)


dump(os.path.join(BASE, 'rooms.json'), rooms)
dump(os.path.join(BASE, 'users.json'), users)
dump(os.path.join(BASE, 'dms.json'), dms)

print(json.dumps(report, ensure_ascii=False))
