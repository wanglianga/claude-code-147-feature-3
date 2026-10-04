#!/usr/bin/env python3
"""端到端验证脚本：覆盖登录、订单、房态、保洁、布草、早餐、事件、差评补偿、结算、复盘、调价、差评归因与补救。"""
import json, subprocess, sys

BASE = 'http://localhost:3000/api'
def call(method, path, token=None, body=None):
    cmd = ['curl', '-s', '-X', method, BASE + path, '-H', 'Content-Type: application/json']
    if token: cmd += ['-H', f'Authorization: Bearer {token}']
    if body is not None: cmd += ['-d', json.dumps(body)]
    out = subprocess.run(cmd, capture_output=True, text=True).stdout
    try: return json.loads(out)
    except Exception: return {'_raw': out}

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
check('20张种子订单', len(bookings) == 20)
b3 = [b for b in bookings if b['guestName'] == '王先生一家'][0]
detail = call('GET', f"/bookings/{b3['id']}", T)
check('订单详情含事件链', len(detail['incidents']) >= 2)  # ac_failure + bad_review
check('订单详情含保洁任务', detail['cleaningTask'] is not None)
check('订单详情含差评(客人已改4分)', detail['review'] and detail['review']['rating'] == 4)
check('结算含佣金/补偿/押金行', len(detail['settlement']['lines']) == 7)
s = detail['settlement']
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

print('== 6. 差评与补偿 ==')
reviews = call('GET', '/reviews', T)
uncomp = [r for r in reviews if r['rating'] <= 3 and not r['compensated']]
check('存在待补偿差评', len(uncomp) >= 2)
comp = call('POST', f"/compensations/for-review/{uncomp[0]['id']}", T, {'type': 'voucher', 'amount': 120})
check('补偿券生成券码', comp.get('voucherCode', '').startswith('VC'))
used = call('POST', f"/compensations/{comp['id']}/use", T)
check('补偿券核销', used['status'] == 'used')
rv = call('POST', '/reviews', T, {'bookingId': new_id, 'rating': 2, 'category': 'service', 'content': '测试差评'})
check('新差评自动生成事件', rv.get('id') is not None)
inc3 = call('GET', '/incidents?type=bad_review&status=open', T)
check('差评事件在链路中', len(inc3) >= 1)

print('== 7. 结算 ==')
st = call('GET', '/settlements?from=2026-10-01&to=2026-10-08', T)
check('结算列表非空', len(st['list']) >= 15)
check('合计=各行求和', abs(st['totals']['net'] - sum(x['net'] for x in st['list'])) < 0.05)
ota_rows = [x for x in st['list'] if x['channelCode'] == 'ota']
check('OTA佣金=房费15%', all(abs(x['commission'] - x['lines'][0]['amount'] * 0.15) < 0.05 for x in ota_rows))

print('== 8. 复盘与调价 ==')
dash = call('GET', '/analytics/dashboard?from=2026-09-28&to=2026-10-08', T)
check('看板KPI完整', all(k in dash['kpi'] for k in ['occupancy', 'adr', 'revpar', 'compensationCost']))
check('差评归因四类可查', len(dash['reviewByCategory']) >= 3)
profit = call('GET', '/analytics/profit?from=2026-10-01&to=2026-10-08', T)
check('分渠道利润', len(profit['byChannel']) == 4)
check('分房型利润', len(profit['byRoomType']) == 4)
check('问题归类三类', {c['type'] for c in profit['classification']} == {'价格策略问题', '履约能力问题', '个别客诉'})
adj = call('GET', '/analytics/adjustment', T)
check('调价建议产出', len(adj['rows']) == 4)
t1 = [r for r in adj['rows'] if r['typeName'] == '山景大床房'][0]
check('超卖房型建议下调可售', t1['adjustedSellable'] < t1['total'], f"{t1['adjustedSellable']}/{t1['total']}")
applied = call('POST', '/analytics/apply-adjustment', T, {'from': '2026-12-31', 'to': '2027-01-02'})
check('调价应用成功', applied.get('ok') is True)
inv2 = call('GET', '/inventory?from=2026-12-31&to=2027-01-02', T)
t1row = [r for r in inv2 if r['typeName'] == '山景大床房'][0]
check('新周期可售=调整值', t1row['days'][0]['sellable'] == t1['adjustedSellable'])

print('== 9. 差评归因与补救 ==')
reviews2 = call('GET', '/reviews', T)
rv6 = [r for r in reviews2 if r['guestName'] == '吴先生'][0]
check('差评挂三维度归因(早餐/潮湿/等待)', {i['dimension'] for i in rv6['issues']} == {'checkin_wait', 'damp', 'breakfast'})
retro = call('GET', f"/reviews/{rv6['id']}/retrospective", T)
ev = retro['evidence']
check('复盘页含早餐备餐记录', len(ev['breakfastPreps']) >= 1)
check('复盘页含除湿设备记录', len(ev['equipmentLogs']) >= 1)
check('复盘页含保洁完成时间', len(ev['cleaningTasks']) >= 1)
check('复盘页含布草延迟记录', any(d['status'] == 'delayed' for d in ev['linenDeliveries']))
check('复盘页含管家沟通记录', len(ev['butlerMessages']) >= 3)
check('归因提示:保洁晚于14:00', retro['findings']['cleaningLate'] is True)
check('归因提示:早餐不足+设备故障', retro['findings']['breakfastShort'] and retro['findings']['equipmentFault'])
check('管家平均响应时长可算', retro['findings']['avgButlerResponseMin'] is not None)
iss = retro['issues'][0]
v = call('POST', f"/review-issues/{iss['id']}/verify", T, {'status': 'confirmed', 'note': '保洁16:20才完成，属实'})
check('归因核实为属实', v['status'] == 'confirmed' and v['evidenceNote'])
# 电话道歉 → 客人拒绝 → 退款 → 客人接受 → 观察 → 客人改评
r1 = call('POST', f"/remediations/for-review/{rv6['id']}", T, {'action': 'phone_apology', 'note': '店主致电致歉'})
check('电话道歉补救发起(零成本)', r1['status'] == 'pending' and r1['amount'] == 0)
rj = call('POST', f"/remediations/{r1['id']}/respond", T, {'accept': False, 'note': '客人认为诚意不足'})
check('客人拒绝道歉', rj['status'] == 'rejected')
r2 = call('POST', f"/remediations/for-review/{rv6['id']}", T, {'action': 'refund', 'amount': 200, 'note': '退款200元致歉'})
check('退款补救生成补偿记录', r2['status'] == 'pending' and r2['compensationId'] is not None)
ra = call('POST', f"/remediations/{r2['id']}/respond", T, {'accept': True})
check('客人接受退款', ra['status'] == 'accepted')
retro1 = call('GET', f"/reviews/{rv6['id']}/retrospective", T)
check('接受后差评事件关闭', all(i['status'] != 'open' for i in retro1['evidence']['incidents'] if i['type'] == 'bad_review'))
check('接受后进入观察期', retro1['review']['watching'] is True)
r3 = call('POST', f"/remediations/for-review/{rv6['id']}", T, {'action': 'voucher', 'amount': 80})
check('补偿券补救生成券码', r3.get('voucherCode', '').startswith('VC'))
dup = call('POST', f"/remediations/for-review/{rv6['id']}", T, {'action': 'refund', 'amount': 10})
check('待回应时重复补救被拒', dup.get('statusCode') == 400)
call('POST', f"/remediations/{r3['id']}/respond", T, {'accept': True})
am = call('POST', f"/reviews/{rv6['id']}/amend", T, {'rating': 4, 'content': '店家退款又补券，处理到位'})
check('客人改回4分观察结束', am['rating'] == 4 and am['watching'] is False)
retro2 = call('GET', f"/reviews/{rv6['id']}/retrospective", T)
check('差评修改历史已记录', len(retro2['amendments']) >= 1 and retro2['amendments'][0]['oldRating'] == 2)
rv5 = [r for r in call('GET', '/reviews', T) if r['guestName'] == '刘女士' and r['rating'] <= 3][0]
rn = call('POST', f"/remediations/for-review/{rv5['id']}", T, {'action': 'none', 'note': '押金已按流程退还'})
check('不予补偿直接关闭并观察', rn['status'] == 'closed')

print('== 10. 渠道评分恢复 / 真实获客成本 / 旺季排班 ==')
rec = call('GET', '/analytics/channel-recovery', T)
mini = [r for r in rec['rows'] if r['channel'] == '小程序'][0]
check('小程序差评恢复(2→4分)', mini['recoveredCount'] >= 1 and mini['avgCurrentRating'] > mini['avgOriginalRating'])
ota_rec = [r for r in rec['rows'] if r['channel'] == 'OTA平台'][0]
check('OTA补救接受率被计算', ota_rec['acceptanceRate'] is not None and ota_rec['accepted'] >= 2)
cac = call('GET', '/analytics/channel-cac?from=2026-10-01&to=2026-10-08', T)
ota = [r for r in cac['rows'] if r['channel'] == 'OTA平台'][0]
check('获客成本=佣金+补偿成本', abs(ota['acquisitionCost'] - (ota['commission'] + ota['compensation'])) < 0.01)
check('补偿成本计入OTA获客成本', ota['compensation'] > 0)
check('单均CAC=获客成本/订单数', abs(ota['cacPerBooking'] - ota['acquisitionCost'] / ota['bookings']) < 0.01)
sp = call('GET', '/analytics/staffing-plan', T)
check('排班建议含保洁/管家/厨房', {r['role'] for r in sp['rows']} == {'cleaner', 'housekeeper', 'kitchen'})
check('排班参考补救接受率', sp['basis']['remediationAcceptanceRate'] is not None)
check('早餐不足驱动厨房增员建议', [r for r in sp['rows'] if r['role'] == 'kitchen'][0]['suggested'] > 1)

print(f'\n结果: {ok} 通过, {fail} 失败')
sys.exit(1 if fail else 0)
