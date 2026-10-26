#!/usr/bin/env python3
# docker/fatal-listener.py
# supervisord 的 eventlistener：子程序（node-bot、oww-server、bgutil-pot）重試 startretries 次都起不來、
# 進入 FATAL 時，supervisord 不會再管它，容器卻照樣活著——OWW 或 bgutil 掛掉時 /healthz 仍回 200，沒有人知道。
#
# 收到 PROCESS_STATE_FATAL：
#   - 送 Discord 告警（有設定 ALERT_WEBHOOK_URL 時）
#   - 對 supervisord 送 SIGTERM：所有子程序正常關閉（node-bot 會寫出播放快照）、容器結束，
#     由 Docker 的 restart: unless-stopped 重新啟動整個容器
#   - 例外：容器啟動後 FATAL_RESTART_MIN_UPTIME_SEC（預設 600 秒）內就 FATAL 的 oww-server／bgutil-pot，
#     代表重啟也救不回來（設定錯、模型檔壞掉），不再重啟，讓 Bot 降級運作（只少了喚醒詞／PO Token），
#     避免整個 Bot 每幾十秒重啟一次、音樂一直中斷。node-bot 本身 FATAL 時一定重啟（Bot 已經不在了）。
#
# 協定（http://supervisord.org/events.html）：stdout 只能寫 READY / RESULT，log 一律寫到 stderr。

import json
import os
import signal
import sys
import time
import urllib.request

STARTED_AT = time.monotonic()
MIN_UPTIME_SEC = float(os.environ.get("FATAL_RESTART_MIN_UPTIME_SEC", "600"))
WEBHOOK_URL = os.environ.get("ALERT_WEBHOOK_URL", "")
ALERT_NAME = os.environ.get("ALERT_NAME", "mousebot")
ALWAYS_RESTART = {"node-bot"}


def log(msg):
    sys.stderr.write(f"[fatal-listener] {msg}\n")
    sys.stderr.flush()


def alert(text):
    if not WEBHOOK_URL:
        return
    try:
        body = json.dumps({"content": f"🚨 **{ALERT_NAME}**：{text}"[:1900], "allowed_mentions": {"parse": []}}).encode()
        req = urllib.request.Request(WEBHOOK_URL, data=body, headers={"Content-Type": "application/json", "User-Agent": "mousebot-alert"})
        urllib.request.urlopen(req, timeout=5).read()
    except Exception as err:  # 告警送不出去不能影響後面的處理
        log(f"告警送出失敗：{err}")


def handle(headers, payload):
    if headers.get("eventname") != "PROCESS_STATE_FATAL":
        return
    fields = dict(token.split(":", 1) for token in payload.split() if ":" in token)
    name = fields.get("processname", "?")
    uptime = time.monotonic() - STARTED_AT
    if name not in ALWAYS_RESTART and uptime < MIN_UPTIME_SEC:
        log(f"{name} 進入 FATAL（容器啟動 {uptime:.0f} 秒），重啟大概也救不回來，維持降級運作")
        alert(f"子程序 `{name}` 啟動失敗（FATAL），容器剛啟動 {uptime:.0f} 秒，不再自動重啟；Bot 降級運作中，請查看 log")
        return
    log(f"{name} 進入 FATAL，結束 supervisord 讓容器重新啟動")
    alert(f"子程序 `{name}` 進入 FATAL，正在重新啟動整個容器")
    os.kill(os.getppid(), signal.SIGTERM)


def main():
    while True:
        sys.stdout.write("READY\n")
        sys.stdout.flush()
        line = sys.stdin.readline()
        if not line:
            return
        headers = dict(token.split(":", 1) for token in line.split())
        payload = sys.stdin.read(int(headers.get("len", 0)))
        try:
            handle(headers, payload)
        except Exception as err:
            log(f"處理事件失敗：{err}")
        sys.stdout.write("RESULT 2\nOK")
        sys.stdout.flush()


if __name__ == "__main__":
    main()
