import React, { useEffect, useState } from 'react';
import {
  Alert, Button, Card, Col, DatePicker, Modal, Popconfirm, Row, Space, Statistic,
  Table, Tag, message,
} from 'antd';
import dayjs from 'dayjs';
import api from '../api';

const CLASS_COLORS = { 价格策略问题: 'blue', 履约能力问题: 'red', 个别客诉: 'gold' };

export default function Analytics() {
  const [range, setRange] = useState([dayjs('2026-10-01'), dayjs('2026-10-08')]);
  const [profit, setProfit] = useState(null);
  const [adjustment, setAdjustment] = useState(null);
  const [cac, setCac] = useState(null);
  const [staffing, setStaffing] = useState(null);
  const [nextRange, setNextRange] = useState([dayjs('2026-12-31'), dayjs('2027-01-02')]);

  const load = async (r = range) => {
    const params = { from: r[0].format('YYYY-MM-DD'), to: r[1].format('YYYY-MM-DD') };
    const [p, a, c, sp] = await Promise.all([
      api.get('/analytics/profit', { params }),
      api.get('/analytics/adjustment'),
      api.get('/analytics/channel-cac', { params }),
      api.get('/analytics/staffing-plan', {
        params: { from: '2026-12-31', to: '2027-01-07', baseFrom: params.from, baseTo: params.to },
      }),
    ]);
    setProfit(p); setAdjustment(a); setCac(c); setStaffing(sp);
  };
  useEffect(() => { load(); }, []);

  if (!profit || !adjustment || !cac || !staffing) return <Card loading />;
  const seg = profit.serviceSegments;

  const profitCols = [
    { title: '名称', dataIndex: 'name' },
    { title: '订单数', dataIndex: 'bookings', width: 80 },
    { title: '应收', dataIndex: 'gross', align: 'right', render: (v) => `¥${v}` },
    { title: '佣金', dataIndex: 'commission', align: 'right', render: (v) => `-¥${v}` },
    { title: '补偿', dataIndex: 'compensation', align: 'right', render: (v) => (v > 0 ? `-¥${v}` : '-') },
    { title: '押金留存', dataIndex: 'depositKept', align: 'right', render: (v) => (v > 0 ? `+¥${v}` : '-') },
    { title: '净收入', dataIndex: 'net', align: 'right', render: (v) => <b>¥{v}</b> },
    { title: '净利率', dataIndex: 'margin', width: 90, align: 'right',
      render: (v) => <span style={{ color: v < 70 ? '#cf1322' : '#2f6b4f' }}>{v}%</span> },
  ];

  return (
    <div>
      <Card style={{ marginBottom: 16 }}>
        <DatePicker.RangePicker value={range} allowClear={false} onChange={(r) => { setRange(r); if (r?.[0]) load(r); }} />
        <span style={{ marginLeft: 12, color: '#888' }}>旺季复盘：分渠道/房型利润、服务环节成本、问题归类与下一轮可售房量调整</span>
      </Card>

      <Row gutter={[16, 16]}>
        <Col xs={24} lg={12}>
          <Card title="分渠道利润"><Table dataSource={profit.byChannel} columns={profitCols} rowKey="name" size="small" pagination={false} /></Card>
        </Col>
        <Col xs={24} lg={12}>
          <Card title="分房型利润"><Table dataSource={profit.byRoomType} columns={profitCols} rowKey="name" size="small" pagination={false} /></Card>
        </Col>
        <Col xs={24} lg={12}>
          <Card title="服务环节收入 vs 成本">
            <Row gutter={16}>
              <Col span={12}>
                <Card size="small" title="收入构成" style={{ marginBottom: 8 }}>
                  <Statistic title="房费" value={seg.revenue.roomFee} prefix="¥" />
                  <Statistic title="加床" value={seg.revenue.extraBed} prefix="¥" />
                  <Statistic title="早餐" value={seg.revenue.breakfast} prefix="¥" />
                  <Statistic title="宠物清洁" value={seg.revenue.petFee} prefix="¥" />
                  <Statistic title="应收合计" value={seg.grossTotal} prefix="¥" valueStyle={{ fontWeight: 700 }} />
                </Card>
              </Col>
              <Col span={12}>
                <Card size="small" title="成本构成">
                  <Statistic title="渠道佣金" value={seg.costs.commission} prefix="¥" />
                  <Statistic title="保洁成本" value={seg.costs.cleaning} prefix="¥" />
                  <Statistic title="布草洗涤" value={seg.costs.linen} prefix="¥" />
                  <Statistic title="早餐食材" value={seg.costs.breakfast} prefix="¥" />
                  <Statistic title="维修" value={seg.costs.maintenance} prefix="¥" />
                  <Statistic title="赔付补偿" value={seg.costs.compensation} prefix="¥" valueStyle={{ color: '#cf1322' }} />
                </Card>
              </Col>
            </Row>
            <Alert style={{ marginTop: 12 }} type={seg.net > 0 ? 'success' : 'error'} showIcon
              message={`旺季净利润 ¥${seg.net}（收入 ¥${seg.grossTotal} - 成本 ¥${seg.costTotal}）`} />
          </Card>
        </Col>
        <Col xs={24} lg={12}>
          <Card title="问题归类（价格策略 / 履约能力 / 个别客诉）">
            {profit.classification.map((c, i) => (
              <Alert key={i} style={{ marginBottom: 12 }} type={c.type === '履约能力问题' ? 'error' : c.type === '价格策略问题' ? 'info' : 'warning'} showIcon
                message={<Space><Tag color={CLASS_COLORS[c.type]}>{c.type}</Tag>{c.evidence}</Space>}
                description={`建议：${c.suggestion}`} />
            ))}
          </Card>
        </Col>
        <Col span={24}>
          <Card title="渠道真实获客成本（佣金 + 已被客人接受的差评补救成本）与渠道评分恢复"
            extra={<span style={{ color: '#888', fontSize: 12 }}>被拒绝/待回应的补偿暂不计入真实成本；补救是否被接受决定渠道权重恢复</span>}>
            <Table dataSource={cac.rows} rowKey="channelId" size="middle" pagination={false}
              summary={() => (
                <Table.Summary fixed>
                  <Table.Summary.Row>
                    <Table.Summary.Cell index={0}><b>合计</b></Table.Summary.Cell>
                    <Table.Summary.Cell index={1}>{cac.totals.bookings}</Table.Summary.Cell>
                    <Table.Summary.Cell index={3}>¥{cac.totals.commission}</Table.Summary.Cell>
                    <Table.Summary.Cell index={4}><b style={{ color: '#cf1322' }}>¥{cac.totals.compensation}</b></Table.Summary.Cell>
                    <Table.Summary.Cell index={5}><b>¥{cac.totals.acquisitionCost}</b></Table.Summary.Cell>
                    <Table.Summary.Cell index={6} colSpan={3} />
                  </Table.Summary.Row>
                </Table.Summary>
              )}
              columns={[
                { title: '渠道', dataIndex: 'name', width: 110 },
                { title: '订单', dataIndex: 'bookings', width: 70 },
                { title: '间夜', dataIndex: 'roomNights', width: 70 },
                { title: '渠道佣金', dataIndex: 'commission', width: 100, render: (v) => `¥${v}` },
                { title: '已接受补救成本', dataIndex: 'compensation', width: 130, render: (v) => v > 0 ? `¥${v}` : '-' },
                { title: '真实获客成本', dataIndex: 'acquisitionCost', width: 120, render: (v) => <b style={{ color: '#d46b08' }}>¥{v}</b> },
                { title: '单均CAC', dataIndex: 'cacPerBooking', width: 100, render: (v) => `¥${v}` },
                { title: '补救接受', dataIndex: 'remediation', width: 150, render: (r) => r.total ? (
                  <Space size={4} wrap><Tag color={r.acceptRate >= 100 ? 'green' : r.acceptRate >= 50 ? 'orange' : 'red'}>{r.acceptRate}%</Tag>
                    <span style={{ fontSize: 12, color: '#888' }}>接受{r.accepted}/拒{r.rejected}/待{r.pending}</span></Space>
                ) : '无补救' },
                { title: '差评评分恢复', dataIndex: 'ratingRecovery', render: (rr) => rr.badCount ? (
                  <Space size={4} wrap>
                    <span style={{ fontSize: 12 }}>{rr.avgOriginal}→<b style={{ color: rr.recovered > 0 ? '#2f6b4f' : '#999' }}>{rr.avgNow}</b></span>
                    <Tag color={rr.revised ? 'green' : 'orange'}>改评{rr.revised}/观察{rr.observing}/未改{rr.unchanged}</Tag>
                  </Space>
                ) : '无差评' },
              ]} />
          </Card>
        </Col>
        <Col span={24}>
          <Card title="下次旺季排班建议（参考本次履约压力 + 补救是否被客人接受）">
            <Space style={{ marginBottom: 12 }} wrap>
              {staffing.rules.map((r, i) => <Tag key={i} color="blue" style={{ fontSize: 12 }}>{r}</Tag>)}
            </Space>
            <Table dataSource={staffing.rows} rowKey="date" size="middle" pagination={false}
              columns={[
                { title: '下次旺季日期', dataIndex: 'date', width: 120 },
                { title: '参考本次', dataIndex: 'basedOn', width: 110 },
                { title: '在住/退房', width: 100, render: (_, r) => `${r.staying} / ${r.checkouts}` },
                { title: '早餐需求', dataIndex: 'breakfastRequired', width: 90, render: (v, r) => `${v}份→备${r.plan.kitchenPortions}` },
                { title: '排班建议', render: (_, r) => (
                  <Space size={4} wrap>
                    <Tag color="cyan">保洁 {r.plan.cleaners} 人</Tag>
                    <Tag color="purple">厨房 {r.plan.kitchenStaff} 人</Tag>
                    <Tag>除湿巡检 {r.plan.dehumidifierChecks} 次</Tag>
                    <Tag>布草安全库存 +{r.plan.linenBuffer}</Tag>
                  </Space>
                ) },
                { title: '补救联动', width: 150, render: (_, r) => (
                  <Space size={4} wrap>
                    {r.riskGuestIds.length > 0 && <Tag color="red">未接受/未改评：{r.riskGuestIds.join('、')} 加排缓冲</Tag>}
                    {r.recoveredGuestIds.length > 0 && <Tag color="green">已接受且改评：{r.recoveredGuestIds.join('、')} 常规排班</Tag>}
                    {!r.riskGuestIds.length && !r.recoveredGuestIds.length && <span style={{ color: '#999' }}>-</span>}
                  </Space>
                ) },
                { title: '风险提示', dataIndex: 'warnings', render: (ws) => ws.length ? ws.map((w, i) => <div key={i} style={{ fontSize: 12, color: '#cf1322' }}>· {w}</div>) : '-' },
              ]} />
            {staffing.channelRisk.length > 0 && (
              <Alert style={{ marginTop: 12 }} type="warning" showIcon
                message="渠道维度：补救接受率低的渠道，其订单集中入住日安排管家专人跟进并压缩旺季配额；接受且改评的渠道恢复正常投放。"
                description={<Space wrap>{staffing.channelRisk.map((c) => (
                  <Tag key={c.channelId} color={c.acceptRate >= 100 ? 'green' : 'red'}>
                    渠道#{c.channelId} 接受率 {c.acceptRate}%（{c.accepted}/{c.total}）
                  </Tag>
                ))}</Space>} />
            )}
          </Card>
        </Col>
        <Col span={24}>
          <Card title="下一轮节假日可售房量调整（基于超卖/布草延迟/早餐投诉/补偿成本）"
            extra={
              <Space>
                <DatePicker.RangePicker value={nextRange} allowClear={false} onChange={(r) => r?.[0] && setNextRange(r)} />
                <Popconfirm title={`将调整后的可售房量应用到 ${nextRange[0].format('YYYY-MM-DD')} ~ ${nextRange[1].format('YYYY-MM-DD')}？`}
                  onConfirm={async () => {
                    await api.post('/analytics/apply-adjustment', {
                      from: nextRange[0].format('YYYY-MM-DD'), to: nextRange[1].format('YYYY-MM-DD'),
                    });
                    message.success('已应用，下一轮节假日库存已按调整后可售量生成');
                  }}>
                  <Button type="primary">应用到下一轮节假日</Button>
                </Popconfirm>
              </Space>
            }>
            <Table dataSource={adjustment.rows} rowKey="typeId" size="middle" pagination={false} columns={[
              { title: '房型', dataIndex: 'typeName', width: 140 },
              { title: '物理房量', dataIndex: 'total', width: 90 },
              { title: '建议可售', dataIndex: 'adjustedSellable', width: 100,
                render: (v, r) => <b style={{ color: v < r.total ? '#d46b08' : '#2f6b4f' }}>{v}</b> },
              { title: '下调', dataIndex: 'reduction', width: 80, render: (v) => v > 0 ? <Tag color="orange">-{v}</Tag> : '-' },
              { title: '超卖', dataIndex: 'oversellCount', width: 80, render: (v) => v > 0 ? <Tag color="red">{v}起</Tag> : '0' },
              { title: '早餐不足', dataIndex: 'breakfastShortages', width: 100, render: (v) => v > 0 ? `${v}天` : '0' },
              { title: '布草延迟率', dataIndex: 'linenDelayRate', width: 100, render: (v) => `${v}%` },
              { title: '补偿成本(已接受)', dataIndex: 'compCost', width: 120, render: (v) => `¥${v}` },
              { title: '补偿占比', dataIndex: 'compRatio', width: 90, render: (v) => `${v}%` },
              { title: '补救/改评', dataIndex: 'remediation', width: 140, render: (r) => r.total ? (
                <Space size={4} direction="vertical" style={{ lineHeight: 1.2 }}>
                  <Tag color={r.unresolved ? 'red' : 'green'}>接受{r.accepted}/{r.total}</Tag>
                  <span style={{ fontSize: 12, color: r.unrevisedBad ? '#cf1322' : '#2f6b4f' }}>未改评差评 {r.unrevisedBad}</span>
                </Space>
              ) : '无补救' },
              { title: '调整原因', dataIndex: 'reasons', render: (v) => v.length ? v.map((r, i) => <div key={i} style={{ fontSize: 12 }}>· {r}</div>) : '履约良好，保持全量可售' },
            ]} />
          </Card>
        </Col>
      </Row>
    </div>
  );
}
