#!/usr/bin/env python3
"""端到端验证：登录、订单、房态、保洁、布草、早餐、事件、差评归因复盘、四种补救、
客人接受/拒绝、改评观察、渠道真实获客成本、旺季排班、结算、复盘、调价。"""
import json, subprocess, sys

BASE = 'http://localhost:3000/api'
def call(method, path, token=None, body=None):
    cmd = ['curl', '-s', '-X', method, BASE + path, '-H', 'Content-Type: application/json']
    if token: cmd += ['-H', f'Authorization: Bearer {token}']
    if body is not None: cmd += ['-d', json.dumps(body, ensure_ascii=False).encode('utf-8')]
    out = subprocess.run(cmd, capture_output=True).stdout
    try: return json.loads(out)
    except Exception: return {'_raw': out.decode('utf-8', 'ignore')}

ok = fail = 0
def check(name, cond, extra=''):
    global ok, fail
    if cond: ok += 1; print(f'  PASS {name} {extra}')
    else: fail += 1; print(f'  FAIL {name} {extra}')

login = call('POST', '/auth/login', body={'username': 'owner', 'password': '123456'})
T = login['token']
print('== 1. 认证 ==')
check('登录签发JWT', bool(T))
check('错误密码被拒', 'statusCode' in call('POST', '/auth/login', body={'username': 'owner', 'password': 'wrong'}))

print('== 2. 房态与库存 ==')
cal = call('GET', '/calendar?from=2026-10-03&to=2026-10-08', T)
check('日历 12间房', len(cal['rooms']) == 12)
inv = call('GET', '/inventory?from=2026-10-01&to=2026-10-08', T)
oversold = [(r['typeName'], d['date']) for r in inv for d in r['days'] if d['oversold']]
check('超卖被识别(10-01双床/10-04大床)', len(oversold) >= 2, str(oversold))

print('== 3. 订单全链路 ==')
bookings = call('GET', '/bookings', T)
check('20张种子订单(含林女士故事线)', len(bookings) == 20, str(len(bookings)))
check('林女士OTA订单存在', any(b['guestName'] == '林女士' for b in bookings))
b3 = [b for b in bookings if b['guestName'] == '王先生一家'][0]
detail = call('GET', f"/bookings/{b3['id']}", T)
check('订单详情含事件链', len(detail['incidents']) >= 2)  # ac_failure + bad_review
check('订单详情含保洁任务', detail['cleaningTask'] is not None)
check('差评原始2分已改评4分', detail['review']['originalRating'] == 2 and detail['review']['rating'] == 4)
check('结算含佣金/补偿/押金行', len(detail['settlement']['lines']) == 7)
s = detail['settlement']
check('已接受补偿券¥100进入订单结算', s['compensation'] == 100, str(s['compensation']))
check('结算净额=应收-佣金-补偿+押金扣留',
      abs(s['net'] - (s['gross'] - s['commission'] - s['compensation'] + s['deposit']['deducted'])) < 0.01)

# 规则校验：禁宠房型带宠物应被拒
rooms = call('GET', '/rooms', T)
channels = call('GET', '/channels', T)
r101 = [r for r in rooms if r['code'] == '101'][0]
ota = [c for c in channels if c['code'] == 'ota'][0]
bad = call('POST', '/bookings', T, {'roomId': r101['id'], 'channelId': ota['id'], 'guestName': '测试',
    'checkIn': '2026-10-10', 'checkOut': '2026-10-11', 'adults': 2, 'pets': 1})
check('禁宠房型带宠物被拒', bad.get('statusCode') == 400, bad.get('message', ''))
# 库存不足非强制应 409
full = call('POST', '/bookings', T, {'roomId': r101['id'], 'channelId': ota['id'], 'guestName': '测试超售',
    'checkIn': '2026-10-04', 'checkOut': '2026-10-05', 'adults': 2})
check('库存不足返回409', full.get('statusCode') == 409, full.get('message', ''))
# OTA 强制下单 → 超卖事件
forced = call('POST', '/bookings', T, {'roomId': r101['id'], 'channelId': ota['id'], 'guestName': '测试强推',
    'checkIn': '2026-10-04', 'checkOut': '2026-10-05', 'adults': 2, 'force': True})
check('OTA强制下单成功', forced.get('code', '').startswith('BK'))
check('强制单触发超卖事件', any(i['type'] == 'oversell' for i in forced.get('incidents', [])))
new_id = forced['id']
# 入住→临时加人→退房(延迟)→保洁任务
call('POST', f'/bookings/{new_id}/check-in', T)
eg = call('POST', f'/bookings/{new_id}/extra-guests', T, {'breakfastCount': 3})
check('临时加人重算早餐费', eg['breakfastFee'] == 3 * eg['nights'] * 38)
co = call('POST', f'/bookings/{new_id}/check-out', T, {'actualTime': '2026-10-05T14:00:00+08:00', 'dirtiness': 'heavy'})
check('延迟退房事件生成', any(i['type'] == 'late_checkout' for i in co['incidents']))
check('退房生成保洁任务', co['cleaningTask'] is not None and co['cleaningTask']['dirtiness'] == 'heavy')
check('押金已退', co['settlement']['deposit']['returned'] == 500)

print('== 4. 保洁与布草 ==')
plan = call('POST', '/cleaning/auto-schedule', T, {'date': '2026-10-03'})
check('智能排班产出方案', len(plan['plan']) >= 1)
check('排班含维修冲突告警', any(w for p in plan['plan'] for w in p['warnings']))
task_id = plan['plan'][0]['taskId']
call('POST', f'/cleaning/tasks/{task_id}/start', T)
stock_before = {s['item']: s['available'] for s in call('GET', '/linen/stock', T)}
call('POST', f'/cleaning/tasks/{task_id}/complete', T, {'linenUsed': 2})
stock_after = {s['item']: s['available'] for s in call('GET', '/linen/stock', T)}
check('完成保洁消耗布草', stock_after['床单'] == stock_before['床单'] - 2)
insp = call('POST', f'/cleaning/tasks/{task_id}/inspect', T)
check('保洁验收', insp['status'] == 'inspected')
# 布草延迟事件
dv = call('POST', '/linen/deliveries', T, {'item': '毛巾', 'quantity': 10, 'expectedAt': '2026-10-01T08:00:00+08:00'})
dv2 = call('POST', f"/linen/deliveries/{dv['id']}/arrive", T)
check('超时签收记为延迟', dv2['status'] == 'delayed')
inc = call('GET', '/incidents?type=linen_delay&status=open', T)
check('布草延迟事件生成', len(inc) >= 1)

print('== 5. 早餐 ==')
bp = call('GET', '/breakfast/plan?date=2026-10-04', T)
check('早餐需求按在住汇总', bp['required'] > 0, f"required={bp['required']}")
check('忌口汇总非空', len(bp['dietary']) >= 1)
conf = call('POST', '/breakfast/confirm', T, {'date': '2026-10-04', 'prepared': bp['required'] - 2})
check('备餐不足标记shortage', conf['status'] == 'shortage')
inc2 = call('GET', '/incidents?type=breakfast_shortage&status=open', T)
check('早餐不足事件生成', len(inc2) >= 1)

print('== 6. 除湿设备与管家沟通 ==')
equip = call('GET', '/equipment', T)
check('除湿机台账非空', len(equip) >= 3)
check('203房除湿机为异常态', any(e['code'] == 'DH-01' and e['status'] == 'abnormal' for e in equip))
dh01 = [e for e in equip if e['code'] == 'DH-01'][0]
log = call('POST', '/equipment/logs', T, {'equipmentId': dh01['id'], 'roomId': dh01['roomId'],
    'date': '2026-10-03', 'status': 'normal', 'humidity': 65, 'note': '维修后复检正常'})
check('登记设备巡检', log.get('id') is not None and log['humidity'] == 65)
rv_list = call('GET', '/reviews', T)
lin = [r for r in rv_list if r['guestName'] == '林女士'][0]
comms_before = len(call('GET', f"/comms?bookingId={lin['bookingId']}", T))
call('POST', '/comms', T, {'bookingId': lin['bookingId'], 'channel': 'phone', 'direction': 'outbound',
    'content': '验证脚本补充的沟通记录', 'staffName': '店主·陈山'})
comms_after = call('GET', f"/comms?bookingId={lin['bookingId']}", T)
check('沟通记录可追加', len(comms_after) == comms_before + 1)

print('== 7. 差评复盘页（五类证据同页） ==')
replay = call('GET', f"/reviews/{lin['id']}/replay", T)
ev = replay['evidence']
check('含五类证据', set(ev.keys()) == {'breakfast', 'equipment', 'cleaning', 'linen', 'comms'})
check('归因标签=早餐少/潮湿/久等', replay['review']['tagsList'] == ['breakfast', 'damp', 'wait'])
check('早餐证据:10-03缺口5份', any(p['date'] == '2026-10-03' and p['gap'] == 5 for p in ev['breakfast']['rows']))
check('除湿证据:异常1次/湿度85', ev['equipment']['abnormalCount'] == 1 and ev['equipment']['maxHumidity'] == 85)
check('保洁证据:入住等待100分钟', ev['cleaning']['checkInWaitMins'] == 100)
check('保洁证据:入住前打扫晚70分钟', ev['cleaning']['roomReadyLateMins'] == 70)
check('布草证据:窗口内至少1起延迟(含种子床单延迟)',
      len(ev['linen']['delays']) >= 1 and any('床单' in d['description'] for d in ev['linen']['delays']))
check('管家沟通≥7条', len(ev['comms']) >= 7)
check('统一时间线非空', len(replay['timeline']) >= 10)
kinds = {t['kind'] for t in replay['timeline']}
check('时间线覆盖沟通/除湿/保洁/早餐', {'comm', 'equipment', 'cleaning', 'breakfast'} <= kinds, str(kinds))
check('复盘页带待回应补救单', len(replay['remediations']) == 1 and replay['remediations'][0]['status'] == 'proposed')

print('== 8. 四种补救决策 / 接受拒绝 / 改评观察 ==')
liu = [r for r in call('GET', '/reviews', T) if r['guestName'] == '刘女士'][0]
# 校验
check('电话道歉带金额被拒', call('POST', f"/remediations/for-review/{liu['id']}", T, {'action': 'call', 'amount': 50}).get('statusCode') == 400)
check('退款金额0被拒', call('POST', f"/remediations/for-review/{liu['id']}", T, {'action': 'refund', 'amount': 0}).get('statusCode') == 400)
check('非法补救方式被拒', call('POST', f"/remediations/for-review/{liu['id']}", T, {'action': 'cash'}).get('statusCode') == 400)
# 先电话道歉 → 客人拒绝 → 改退款 → 客人接受
call('POST', f"/remediations/for-review/{liu['id']}", T, {'action': 'call', 'note': '店主致电致歉'})
liu = [r for r in call('GET', '/reviews', T) if r['guestName'] == '刘女士'][0]
mid_call = liu['remediation']['id']
rej = call('POST', f'/remediations/{mid_call}/respond', T, {'accepted': False, 'note': '电话不够诚意'})
check('客人拒绝登记', rej['status'] == 'rejected')
call('POST', f"/remediations/for-review/{liu['id']}", T, {'action': 'refund', 'amount': 80, 'note': '押金慢+房费部分退还'})
liu = [r for r in call('GET', '/reviews', T) if r['guestName'] == '刘女士'][0]
mid_ref = liu['remediation']['id']
acc = call('POST', f'/remediations/{mid_ref}/respond', T, {'accepted': True, 'note': '退款收到'})
check('客人接受退款登记', acc['status'] == 'accepted' and acc['amount'] == 80)
liu_after = [r for r in call('GET', '/reviews', T) if r['guestName'] == '刘女士'][0]
hist = [(m['action'], m['status']) for m in liu_after['remediationActions']]
check('拒绝的电话道歉留档、退款被接受', ('call', 'rejected') in hist and ('refund', 'accepted') in hist)
# 刘女士在 OTA 渠道，其差评事件应已关闭
liu_inc = call('GET', '/incidents?type=bad_review&status=resolved', T)
check('接受后差评事件关闭', any(i['bookingId'] == liu['bookingId'] for i in liu_inc))
# 不予补偿：新建测试差评；先下补偿券再改"不予补偿"，旧待回应单应作废且券作废
rv_new = call('POST', '/reviews', T, {'bookingId': new_id, 'rating': 2, 'category': 'service',
    'content': '测试差评', 'tags': ['wait']})
check('新差评自动进入观察', rv_new['monitorStatus'] == 'observing')
call('POST', f"/remediations/for-review/{rv_new['id']}", T, {'action': 'voucher', 'amount': 60, 'note': '先按券处理'})
call('POST', f"/remediations/for-review/{rv_new['id']}", T, {'action': 'none', 'note': '核实为误解，不予补偿'})
rv_new = [r for r in call('GET', '/reviews', T) if r['id'] == rv_new['id']][0]
check('不予补偿不产生金额', rv_new['remediation']['action'] == 'none' and float(rv_new['remediation']['amount']) == 0)
check('不予补偿状态=closed', rv_new['remediation']['status'] == 'closed')
check('重新决策后旧待回应单作废', any(m['status'] == 'void' for m in rv_new['remediationActions']))
new_comps = [c for c in call('GET', '/compensations', T) if c['reviewId'] == rv_new['id']]
check('作废补救的补偿券同步作废', any(c['type'] == 'voucher' and c['status'] == 'cancelled' for c in new_comps))
open_inc = call('GET', '/incidents?type=bad_review&status=open', T)
check('不予补偿差评事件保持待处理', any(i['bookingId'] == new_id for i in open_inc))
fm = call('POST', f"/reviews/{rv_new['id']}/finish-monitor", T)
check('观察结束标记未改评', fm['monitorStatus'] == 'unchanged')

# 林女士：接受补偿券 → 改评 2→4 → 券核销
lin = [r for r in call('GET', '/reviews', T) if r['guestName'] == '林女士'][0]
lin_mid = lin['remediation']['id']
lin_code = lin['remediation']['voucherCode']
check('补偿券自动生成券码', bool(lin_code) and lin_code.startswith('VC'))
# 接受前：待回应补偿不计入真实成本
# OTA 此时只有：冯女士现金50（旧链路）+ 刘女士退款80（已接受）；林女士150仍待回应
cac0 = call('GET', '/analytics/channel-cac?from=2026-10-01&to=2026-10-08', T)
ota0 = [r for r in cac0['rows'] if r['name'] == 'OTA平台'][0]['compensation']
check('待回应补偿不计入真实CAC(仍为130)', ota0 == 130, str(ota0))
call('POST', f'/remediations/{lin_mid}/respond', T, {'accepted': True, 'note': '券收到，愿意改评'})
cac1 = call('GET', '/analytics/channel-cac?from=2026-10-01&to=2026-10-08', T)
ota1 = [r for r in cac1['rows'] if r['name'] == 'OTA平台'][0]
check('接受后真实CAC增加150', round(ota1['compensation'] - ota0, 2) == 150, f"{ota0}->{ota1['compensation']}")
voucher = [c for c in call('GET', '/compensations', T) if c.get('voucherCode') == lin_code][0]
used = call('POST', f"/compensations/{voucher['id']}/use", T)
check('补偿券可核销', used['status'] == 'used')
rev = call('POST', f"/reviews/{lin['id']}/revise", T, {'rating': 4, 'content': '管家补救及时，改4分'})
check('客人改评2→4留档', rev['originalRating'] == 2 and rev['rating'] == 4 and rev['monitorStatus'] == 'revised')
ota_after = [r for r in call('GET', '/analytics/channel-cac?from=2026-10-01&to=2026-10-08', T)['rows'] if r['name'] == 'OTA平台'][0]
check('OTA渠道评分恢复(均分上升)', ota_after['ratingRecovery']['avgNow'] > ota_after['ratingRecovery']['avgOriginal'])
check('OTA渠道林女士已改评(改评数=1)', ota_after['ratingRecovery']['revised'] == 1)
# OTA差评：林女士已改评；刘女士接受退款但尚未改评(观察中)；冯女士+测试差评未改评
check('接受但未改评仍在观察(观察1/未改2)',
      ota_after['ratingRecovery']['observing'] == 1 and ota_after['ratingRecovery']['unchanged'] == 2,
      str(ota_after['ratingRecovery']))
# OTA补救尝试：电话道歉被拒1 + 退款接受1 + 林女士补偿券接受1 → 接受率 2/3
check('OTA补救接受率=2/3尝试被接受', ota_after['remediation']['acceptRate'] == 66.67, str(ota_after['remediation']))
# 不予补偿单不进入接受率分母（新差评所在渠道同为OTA）
check('closed补救不计入补救分母', ota_after['remediation']['total'] == 3, str(ota_after['remediation']['total']))

print('== 9. 结算（真实补偿口径） ==')
st = call('GET', '/settlements?from=2026-10-01&to=2026-10-08', T)
check('结算列表非空', len(st['list']) >= 15)
check('合计=各行求和', abs(st['totals']['net'] - sum(x['net'] for x in st['list'])) < 0.05)
ota_rows = [x for x in st['list'] if x['channelCode'] == 'ota']
check('OTA佣金=房费15%', all(abs(x['commission'] - x['lines'][0]['amount'] * 0.15) < 0.05 for x in ota_rows))
lin_settle = [x for x in st['list'] if x['guestName'] == '林女士'][0]
check('林女士结算含已接受补偿券150', lin_settle['compensation'] == 150)

print('== 10. 看板 / 复盘 / 排班 / 调价 ==')
dash = call('GET', '/analytics/dashboard?from=2026-09-28&to=2026-10-08', T)
for k in ['remediationCount', 'remediationAccepted', 'remediationRejected', 'remediationPending',
          'remediationAcceptRate', 'revisedCount', 'monitoringCount', 'unchangedCount', 'ratingRecovered']:
    check(f'看板KPI含 {k}', k in dash['kpi'])
check('差评归因四类可查', len(dash['reviewByCategory']) >= 3)
profit = call('GET', '/analytics/profit?from=2026-10-01&to=2026-10-08', T)
check('分渠道利润', len(profit['byChannel']) == 4)
check('分房型利润', len(profit['byRoomType']) == 4)
check('问题归类三类', {c['type'] for c in profit['classification']} == {'价格策略问题', '履约能力问题', '个别客诉'})
# 排班
sp = call('GET', '/analytics/staffing-plan?from=2026-12-31&to=2027-01-07&baseFrom=2026-10-01&baseTo=2026-10-08', T)
check('排班建议8天', len(sp['rows']) == 8)
check('排班含保洁/厨房/除湿/布草建议',
      all(set(r['plan'].keys()) == {'cleaners', 'kitchenStaff', 'kitchenPortions', 'dehumidifierChecks', 'linenBuffer'} for r in sp['rows']))
check('排班参考补救接受情况(有联动或提示)',
      any(r['riskGuestIds'] or r['recoveredGuestIds'] or any('补救' in w for w in r['warnings']) for r in sp['rows']))
base1002 = [r for r in sp['rows'] if r['basedOn'] == '2026-10-02'][0]
check('10-02基准日识别布草延迟+布草缓冲10', base1002['plan']['linenBuffer'] == 10)
check('10-03基准日早餐不足加厨房帮工', [r for r in sp['rows'] if r['basedOn'] == '2026-10-03'][0]['plan']['kitchenStaff'] == 2)
# 调价
adj = call('GET', '/analytics/adjustment', T)
check('调价建议产出', len(adj['rows']) == 4)
t2 = [r for r in adj['rows'] if r['typeName'] == '庭院双床房'][0]
check('调价行含补救/改评统计', {'total', 'accepted', 'unresolved', 'unrevisedBad'} <= set(t2['remediation'].keys()))
check('未改评差评触发下调理由', any('未改评' in x or '未被接受' in x for x in t2['reasons']))
t1 = [r for r in adj['rows'] if r['typeName'] == '山景大床房'][0]
check('超卖房型建议下调可售', t1['adjustedSellable'] < t1['total'], f"{t1['adjustedSellable']}/{t1['total']}")
applied = call('POST', '/analytics/apply-adjustment', T, {'from': '2026-12-31', 'to': '2027-01-02'})
check('调价应用成功', applied.get('ok') is True)
inv2 = call('GET', '/inventory?from=2026-12-31&to=2027-01-02', T)
t1row = [r for r in inv2 if r['typeName'] == '山景大床房'][0]
check('新周期可售=调整值', t1row['days'][0]['sellable'] == t1['adjustedSellable'])

print(f'\n结果: {ok} 通过, {fail} 失败')
sys.exit(1 if fail else 0)
