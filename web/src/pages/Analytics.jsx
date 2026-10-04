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
  const [recovery, setRecovery] = useState(null);
  const [cac, setCac] = useState(null);
  const [staffing, setStaffing] = useState(null);
  const [nextRange, setNextRange] = useState([dayjs('2026-12-31'), dayjs('2027-01-02')]);

  const load = async (r = range) => {
    const params = { from: r[0].format('YYYY-MM-DD'), to: r[1].format('YYYY-MM-DD') };
    const [p, a, rec, c, s] = await Promise.all([
      api.get('/analytics/profit', { params }),
      api.get('/analytics/adjustment'),
      api.get('/analytics/channel-recovery'),
      api.get('/analytics/channel-cac', { params }),
      api.get('/analytics/staffing-plan', {
        params: { from: nextRange[0].format('YYYY-MM-DD'), to: nextRange[1].format('YYYY-MM-DD') },
      }),
    ]);
    setProfit(p); setAdjustment(a); setRecovery(rec); setCac(c); setStaffing(s);
  };
  useEffect(() => { load(); }, []);

  if (!profit || !adjustment || !recovery || !cac || !staffing) return <Card loading />;
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
        <Col xs={24} lg={12}>
          <Card title="渠道评分恢复（参考补救是否被客人接受）">
            <Table dataSource={recovery.rows} rowKey="channelId" size="small" pagination={false} columns={[
              { title: '渠道', dataIndex: 'channel', width: 90 },
              { title: '差评', dataIndex: 'badReviewCount', width: 60 },
              { title: '已补救', dataIndex: 'remediated', width: 70 },
              { title: '接受率', dataIndex: 'acceptanceRate', width: 80, render: (v) => v === null ? '-' : <b style={{ color: v >= 60 ? '#2f6b4f' : '#cf1322' }}>{v}%</b> },
              { title: '客人改评', dataIndex: 'amendedCount', width: 80 },
              { title: '恢复率', dataIndex: 'recoveryRate', width: 80, render: (v) => `${v}%` },
              {
                title: '均分(原始→当前)', width: 130, render: (_, r) => (
                  r.avgOriginalRating === null ? '-' : (
                    <span>{r.avgOriginalRating} → <b style={{ color: r.avgCurrentRating > r.avgOriginalRating ? '#2f6b4f' : undefined }}>{r.avgCurrentRating}</b></span>
                  )
                ),
              },
              { title: '观察中', dataIndex: 'watching', width: 70, render: (v) => v > 0 ? <Tag color="processing">{v}</Tag> : '0' },
            ]} />
          </Card>
        </Col>
        <Col xs={24} lg={12}>
          <Card title="渠道真实获客成本（佣金 + 差评补偿成本）">
            <Table dataSource={cac.rows} rowKey="channelId" size="small" pagination={false} columns={[
              { title: '渠道', dataIndex: 'channel', width: 90 },
              { title: '订单', dataIndex: 'bookings', width: 60 },
              { title: '佣金', dataIndex: 'commission', align: 'right', render: (v) => `¥${v}` },
              { title: '补偿成本', dataIndex: 'compensation', align: 'right', render: (v) => v > 0 ? <span style={{ color: '#cf1322' }}>¥{v}</span> : '-' },
              { title: '获客成本', dataIndex: 'acquisitionCost', align: 'right', render: (v) => <b>¥{v}</b> },
              { title: '单均CAC', dataIndex: 'cacPerBooking', align: 'right', render: (v) => `¥${v}` },
              { title: '间夜CAC', dataIndex: 'cacPerNight', align: 'right', render: (v) => `¥${v}` },
              { title: '成本占比', dataIndex: 'costRatio', width: 90, render: (v) => <span style={{ color: v > 10 ? '#cf1322' : undefined }}>{v}%</span> },
            ]} />
            <Alert style={{ marginTop: 8 }} type="info" showIcon
              message={`全渠道真实获客成本 ¥${cac.totals.acquisitionCost}，单均 CAC ¥${cac.totals.cacPerBooking}（${cac.range.from} ~ ${cac.range.to}）`} />
          </Card>
        </Col>
        <Col span={24}>
          <Card title={`下次旺季排班建议（${staffing.range.from} ~ ${staffing.range.to}，参考补救接受率 ${staffing.basis.remediationAcceptanceRate}%）`}>
            <Row gutter={16}>
              {staffing.rows.map((r) => (
                <Col xs={24} md={8} key={r.role}>
                  <Card size="small" title={`${r.roleName}：${r.current} 人 → 建议 ${r.suggested} 人`}
                    headStyle={{ background: r.suggested > r.current ? '#fff7e6' : '#f6ffed' }}>
                    <Statistic title="建议增员" value={Math.max(0, r.suggested - r.current)} suffix="人"
                      valueStyle={{ color: r.suggested > r.current ? '#d46b08' : '#2f6b4f' }} />
                    {r.reasons.map((x, i) => <div key={i} style={{ fontSize: 12, color: '#666' }}>· {x}</div>)}
                  </Card>
                </Col>
              ))}
            </Row>
            <Alert style={{ marginTop: 12 }} type="info" showIcon
              message={`排班依据：峰值日保洁 ${staffing.basis.peakTasks} 单（单均 ${staffing.basis.avgCleanMin} 分钟）、布草延迟率 ${staffing.basis.linenDelayRate}%、管家平均响应 ${staffing.basis.avgButlerResponseMin} 分钟、补救接受率 ${staffing.basis.remediationAcceptanceRate}%、早餐不足 ${staffing.basis.breakfastShortageDays} 天、已恢复差评 ${staffing.basis.recoveredBadReviews} 条`} />
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
              { title: '补偿成本', dataIndex: 'compCost', width: 100, render: (v) => `¥${v}` },
              { title: '补偿占比', dataIndex: 'compRatio', width: 90, render: (v) => `${v}%` },
              { title: '调整原因', dataIndex: 'reasons', render: (v) => v.length ? v.map((r, i) => <div key={i} style={{ fontSize: 12 }}>· {r}</div>) : '履约良好，保持全量可售' },
            ]} />
          </Card>
        </Col>
      </Row>
    </div>
  );
}
