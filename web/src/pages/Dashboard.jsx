import React, { useEffect, useState } from 'react';
import { Card, Col, DatePicker, Row, Statistic, Table, Tag } from 'antd';
import dayjs from 'dayjs';
import api, { INCIDENT_TYPES, REVIEW_CATEGORIES } from '../api';
import Chart from '../components/Chart';

export default function Dashboard() {
  const [range, setRange] = useState([dayjs('2026-09-28'), dayjs('2026-10-08')]);
  const [data, setData] = useState(null);

  const load = async (r = range) => {
    const d = await api.get('/analytics/dashboard', {
      params: { from: r[0].format('YYYY-MM-DD'), to: r[1].format('YYYY-MM-DD') },
    });
    setData(d);
  };
  useEffect(() => { load(); }, []);

  if (!data) return <Card loading />;
  const { kpi } = data;

  return (
    <div>
      <Card style={{ marginBottom: 16 }} styles={{ body: { paddingBottom: 8 } }}>
        <DatePicker.RangePicker value={range} onChange={(r) => { setRange(r); if (r?.[0]) load(r); }} allowClear={false} />
        <span style={{ marginLeft: 12, color: '#888' }}>旺季经营概览（国庆 10-01 ~ 10-07）</span>
      </Card>
      <Row gutter={[16, 16]}>
        {[
          { title: '入住率', value: kpi.occupancy, suffix: '%' },
          { title: '已售间夜', value: kpi.soldNights, suffix: `/${kpi.roomNightsAvailable}` },
          { title: '总收入(¥)', value: kpi.revenue },
          { title: 'ADR 平均房价(¥)', value: kpi.adr },
          { title: 'RevPAR(¥)', value: kpi.revpar },
          { title: '真实补偿成本(¥)', value: kpi.compensationCost },
          { title: '差评数', value: kpi.badReviewCount, suffix: `/${kpi.reviewCount}` },
          { title: '平均评分', value: kpi.avgRating },
          { title: '补救接受率', value: kpi.remediationAcceptRate, suffix: `%（${kpi.remediationAccepted}/${kpi.remediationCount}）` },
          { title: '待客人回应', value: kpi.remediationPending, suffix: `单，拒绝 ${kpi.remediationRejected}` },
          { title: '已改评恢复', value: kpi.revisedCount, suffix: `单，观察中 ${kpi.monitoringCount}` },
          { title: '评分恢复', value: kpi.ratingRecovered, suffix: '分（未改评 ' + kpi.unchangedCount + '）' },
        ].map((s) => (
          <Col xs={12} md={6} key={s.title}>
            <Card><Statistic title={s.title} value={s.value} suffix={s.suffix} precision={String(s.value).includes('.') ? 2 : 0} /></Card>
          </Col>
        ))}
      </Row>
      <Row gutter={[16, 16]} style={{ marginTop: 16 }}>
        <Col xs={24} lg={12}>
          <Card title="每日入住率">
            <Chart option={{
              tooltip: { trigger: 'axis' },
              xAxis: { type: 'category', data: data.daily.map((d) => d.date.slice(5)) },
              yAxis: [{ type: 'value', name: '间夜' }, { type: 'value', name: '%', max: 100 }],
              series: [
                { name: '已售间夜', type: 'bar', data: data.daily.map((d) => d.sold), itemStyle: { color: '#2f6b4f' } },
                { name: '入住率', type: 'line', yAxisIndex: 1, data: data.daily.map((d) => d.occupancy), itemStyle: { color: '#d48806' } },
              ],
            }} />
          </Card>
        </Col>
        <Col xs={24} lg={12}>
          <Card title="渠道收入分布">
            <Chart option={{
              tooltip: { trigger: 'item', formatter: '{b}: ¥{c} ({d}%)' },
              series: [{ type: 'pie', radius: ['40%', '70%'], data: data.revenueByChannel,
                label: { formatter: '{b}\n¥{c}' } }],
            }} />
          </Card>
        </Col>
        <Col xs={24} lg={12}>
          <Card title="履约事件分布（延迟退房/超卖/布草/早餐/故障…）">
            <Chart option={{
              tooltip: {},
              xAxis: { type: 'category', data: data.incidentsByType.map((i) => INCIDENT_TYPES[i.type] || i.type), axisLabel: { rotate: 30 } },
              yAxis: { type: 'value', minInterval: 1 },
              series: [{ type: 'bar', data: data.incidentsByType.map((i) => i.count), itemStyle: { color: '#c05a4e' } }],
            }} />
          </Card>
        </Col>
        <Col xs={24} lg={12}>
          <Card title="差评归因（硬件/服务/超卖/餐食）">
            <Chart option={{
              tooltip: { trigger: 'item' },
              series: [{ type: 'pie', radius: ['40%', '70%'],
                data: data.reviewByCategory.map((r) => ({ name: REVIEW_CATEGORIES[r.category] || r.category, value: r.count })),
                label: { formatter: '{b}: {c}条' } }],
            }} />
          </Card>
        </Col>
      </Row>
    </div>
  );
}
