import React, { useEffect, useMemo, useState } from 'react';
import {
  Alert, Button, Card, Col, Descriptions, Empty, Form, Input, InputNumber, Modal,
  Radio, Row, Select, Space, Statistic, Table, Tag, Timeline, message,
} from 'antd';
import {
  ArrowLeftOutlined, CoffeeOutlined, CloudOutlined, ClearOutlined,
  BlockOutlined, MessageOutlined, FieldTimeOutlined,
} from '@ant-design/icons';
import { useNavigate, useParams } from 'react-router-dom';
import dayjs from 'dayjs';
import api, {
  COMM_CHANNEL, MONITOR_STATUS, REMEDIATION_ACTIONS, REMEDIATION_STATUS,
  REVIEW_CATEGORIES, REVIEW_TAGS,
} from '../api';

const KIND_COLOR = {
  comm: 'blue', equipment: 'red', cleaning: 'cyan', breakfast: 'purple', incident: 'red', review: 'gold',
};
const KIND_LABEL = {
  comm: '沟通', equipment: '除湿', cleaning: '保洁', breakfast: '早餐', incident: '事件', review: '评价',
};

export default function ReviewReplay() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [reviewList, setReviewList] = useState([]);
  const [form] = Form.useForm();
  const [commForm] = Form.useForm();
  const [action, setAction] = useState('voucher');
  const [reviseOpen, setReviseOpen] = useState(false);
  const [reviseForm] = Form.useForm();

  const load = async (rid = id) => {
    const d = await api.get(`/reviews/${rid}/replay`);
    setData(d);
    setAction(d.remediations?.length ? d.remediations[d.remediations.length - 1].action : 'voucher');
  };
  useEffect(() => {
    api.get('/reviews').then((rows) => {
      setReviewList(rows);
      if (!id && rows.length) {
        const target = rows.find((r) => r.monitorStatus === 'observing') || rows[0];
        navigate(`/reviews/${target.id}`, { replace: true });
      }
    });
  }, []);
  useEffect(() => { if (id) load(id); }, [id]);

  const active = useMemo(
    () => (data ? [...data.remediations].reverse().find((m) => m.status !== 'void') : null),
    [data],
  );

  if (!id) return <Card loading />;
  if (!data) return <Card loading />;

  const { review, evidence: e, timeline } = data;
  const ratingUp = (review.originalRating ?? review.rating) < review.rating;

  const decide = async (v) => {
    const payload = { action: v.action, note: v.note || '' };
    if (v.action === 'refund' || v.action === 'voucher') payload.amount = v.amount;
    await api.post(`/remediations/for-review/${review.id}`, payload);
    message.success('补救决策已下发，差评事件进入处理中，平台开始观察客人是否改评');
    form.resetFields();
    load();
  };

  const respond = async (accepted) => {
    let note = '';
    if (accepted) note = window.prompt('客人接受时的备注（可留空）') || '';
    else note = window.prompt('客人拒绝原因（将退回差评事件重新补救）') || '';
    if (accepted || note !== null) {
      await api.post(`/remediations/${active.id}/respond`, { accepted, note: note || undefined });
      message.success(accepted ? '已登记：客人接受补救，差评事件关闭' : '已登记：客人拒绝，差评事件退回待处理');
      load();
    }
  };

  return (
    <div>
      <Card style={{ marginBottom: 16 }}
        title={<Space>
          <Button icon={<ArrowLeftOutlined />} onClick={() => navigate('/incidents')}>返回差评列表</Button>
          <span>差评归因与补救复盘</span>
        </Space>}
        extra={<Select style={{ width: 380 }} showSearch optionFilterProp="label" value={Number(id)}
          onChange={(v) => navigate(`/reviews/${v}`)}
          options={reviewList.map((r) => ({
            value: r.id,
            label: `${r.guestName} · ${r.channel} · ${r.rating}分${r.originalRating && r.originalRating !== r.rating ? `（原${r.originalRating}）` : ''} · ${r.content.slice(0, 14)}`,
          }))} />}>
        <Descriptions column={{ xs: 1, md: 3 }} size="small">
          <Descriptions.Item label="客人 / 订单">{review.guestName}（{review.bookingCode}）· {review.room}房</Descriptions.Item>
          <Descriptions.Item label="渠道">{review.channel} · {review.checkIn} ~ {review.checkOut}</Descriptions.Item>
          <Descriptions.Item label="评分">
            {review.originalRating && review.originalRating !== review.rating ? (
              <Space><span style={{ textDecoration: 'line-through', color: '#999' }}>{review.originalRating}分</span>
                <b style={{ color: '#2f6b4f', fontSize: 16 }}>{review.rating}分</b>
                <Tag color={ratingUp ? 'green' : 'red'}>{ratingUp ? `↑${review.rating - review.originalRating} 已改评恢复` : '评分下降'}</Tag>
              </Space>
            ) : <b style={{ color: '#cf1322', fontSize: 16 }}>{review.rating}分</b>}
            <Tag style={{ marginLeft: 8 }}>{REVIEW_CATEGORIES[review.category]}</Tag>
          </Descriptions.Item>
          <Descriptions.Item label="归因标签" span={2}>
            <Space wrap>
              {review.tagsList.length ? review.tagsList.map((t) =>
                <Tag key={t} color="volcano">{REVIEW_TAGS[t] || t}</Tag>) : <span style={{ color: '#999' }}>未细分</span>}
            </Space>
          </Descriptions.Item>
          <Descriptions.Item label="改评观察">
            <Tag color={MONITOR_STATUS[review.monitorStatus]?.color}>{MONITOR_STATUS[review.monitorStatus]?.text}</Tag>
          </Descriptions.Item>
          <Descriptions.Item label="评价内容" span={3}>"{review.content}"</Descriptions.Item>
          {review.revisedContent && (
            <Descriptions.Item label="改评内容" span={3}>
              <span style={{ color: '#2f6b4f' }}>"{review.revisedContent}"</span>
              <span style={{ color: '#999', marginLeft: 8 }}>{dayjs(review.revisedAt).format('MM-DD HH:mm')}</span>
            </Descriptions.Item>
          )}
        </Descriptions>
      </Card>

      <Row gutter={[16, 16]}>
        <Col xs={24} xl={16}>
          <Space direction="vertical" size={16} style={{ width: '100%' }}>
            <Card size="small" title={<Space><CoffeeOutlined />早餐备餐</Space>}
              extra={<Tag color={e.breakfast.rows.some((p) => p.gap > 0) ? 'red' : 'green'}>
                {e.breakfast.rows.some((p) => p.gap > 0) ? '备餐不足' : '供应正常'}</Tag>}>
              <Alert type={e.breakfast.rows.some((p) => p.gap > 0) ? 'error' : 'success'} showIcon
                style={{ marginBottom: 8 }} message={e.breakfast.summary}
                description={`该单每日早餐 ${e.breakfast.portions} 份${e.breakfast.dietary ? `，忌口：${e.breakfast.dietary}` : ''}`} />
              <Table size="small" rowKey="date" pagination={false} dataSource={e.breakfast.rows}
                columns={[
                  { title: '供应日', dataIndex: 'date', width: 110 },
                  { title: '需求(份)', dataIndex: 'required', width: 80 },
                  { title: '实备(份)', dataIndex: 'prepared', width: 80 },
                  { title: '缺口', dataIndex: 'gap', width: 70, render: (v) => v > 0 ? <Tag color="red">缺{v}</Tag> : '-' },
                  { title: '备注', dataIndex: 'note', render: (v) => v || '-' },
                ]} />
            </Card>

            <Card size="small" title={<Space><CloudOutlined />除湿设备</Space>}
              extra={<Tag color={e.equipment.abnormalCount ? 'red' : 'green'}>{e.equipment.abnormalCount ? '设备异常' : '运行正常'}</Tag>}>
              <Row gutter={16} style={{ marginBottom: 8 }}>
                <Col span={8}><Statistic title="异常次数" value={e.equipment.abnormalCount} valueStyle={{ color: e.equipment.abnormalCount ? '#cf1322' : undefined }} /></Col>
                <Col span={8}><Statistic title="记录最高湿度" value={e.equipment.maxHumidity} suffix="%" valueStyle={{ color: e.equipment.maxHumidity >= 80 ? '#cf1322' : undefined }} /></Col>
                <Col span={8}><Statistic title="巡检记录" value={e.equipment.logs.length} suffix="条" /></Col>
              </Row>
              <Alert type={e.equipment.abnormalCount ? 'error' : 'success'} showIcon style={{ marginBottom: 8 }} message={e.equipment.summary} />
              <Table size="small" rowKey="id" pagination={false} dataSource={e.equipment.logs}
                columns={[
                  { title: '时间', dataIndex: 'recordedAt', width: 130, render: (v) => dayjs(v).format('MM-DD HH:mm') },
                  { title: '设备', dataIndex: ['equipment', 'code'], width: 90 },
                  { title: '状态', dataIndex: 'status', width: 80, render: (v) => <Tag color={v === 'abnormal' ? 'red' : 'green'}>{v === 'abnormal' ? '异常' : '正常'}</Tag> },
                  { title: '湿度', dataIndex: 'humidity', width: 70, render: (v) => v ? `${v}%` : '-' },
                  { title: '说明', dataIndex: 'note', render: (v) => v || '-' },
                ]} />
            </Card>

            <Card size="small" title={<Space><ClearOutlined />保洁完成时间 · 入住等待</Space>}
              extra={<Tag color={e.cleaning.checkInWaitMins ? 'red' : 'green'}>{e.cleaning.checkInWaitMins ? `等待${e.cleaning.checkInWaitMins}分钟` : '准时入住'}</Tag>}>
              <Alert type={e.cleaning.checkInWaitMins ? 'error' : 'success'} showIcon style={{ marginBottom: 8 }} message={e.cleaning.summary} />
              <Table size="small" rowKey="id" pagination={false} dataSource={e.cleaning.tasks}
                columns={[
                  { title: '日期', dataIndex: 'date', width: 100 },
                  { title: '保洁', dataIndex: 'assignee', width: 100, render: (v) => v || '未派单' },
                  { title: '脏污', dataIndex: 'dirtiness', width: 70, render: (v) => ({ light: '轻度', normal: '常规', heavy: '重度' })[v] },
                  { title: '计划开始', dataIndex: 'scheduledStart', width: 110, render: (v) => v ? dayjs(v).format('MM-DD HH:mm') : '-' },
                  { title: '完成时间', dataIndex: 'finishedAt', width: 110, render: (v) => v ? dayjs(v).format('MM-DD HH:mm') : '-' },
                  { title: '超14:00', dataIndex: 'finishedLateMins', width: 90, render: (v) => v ? <Tag color="red">晚{v}分</Tag> : '-' },
                  { title: '备注', dataIndex: 'notes', render: (v) => v || '-' },
                ]} />
            </Card>

            <Card size="small" title={<Space><BlockOutlined />布草延迟</Space>}
              extra={<Tag color={e.linen.delays.length ? 'red' : 'green'}>{e.linen.delays.length ? `${e.linen.delays.length} 起延迟` : '无延迟'}</Tag>}>
              <Alert type={e.linen.delays.length ? 'warning' : 'success'} showIcon style={{ marginBottom: 8 }} message={e.linen.summary} />
              {e.linen.delays.length ? (
                <Space direction="vertical" style={{ width: '100%' }}>
                  {e.linen.delays.map((d) => <Alert key={d.id} type="warning" showIcon message={d.description}
                    description={`处理：${d.resolution || '待处理'}`} />)}
                </Space>
              ) : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="住宿窗口内无布草延迟" />}
            </Card>
          </Space>
        </Col>

        <Col xs={24} xl={8}>
          <Space direction="vertical" size={16} style={{ width: '100%' }}>
            <Card size="small" title="店主补救决策">
              {active ? (
                <Alert style={{ marginBottom: 12 }} type={active.status === 'accepted' ? 'success' : active.status === 'rejected' ? 'error' : 'warning'} showIcon
                  message={<Space><Tag color={REMEDIATION_ACTIONS[active.action]?.color}>{REMEDIATION_ACTIONS[active.action]?.text}</Tag>
                    {active.amount ? `¥${active.amount}` : ''}{active.voucherCode ? ` 券码 ${active.voucherCode}` : ''}
                    <Tag color={REMEDIATION_STATUS[active.status]?.color}>{REMEDIATION_STATUS[active.status]?.text}</Tag></Space>}
                  description={<div>
                    <div>{active.note || '无备注'}</div>
                    <div style={{ color: '#999', marginTop: 4 }}>
                      {active.decidedBy} · {dayjs(active.decidedAt).format('MM-DD HH:mm')}
                      {active.guestRespondedAt ? ` · 客人回应 ${dayjs(active.guestRespondedAt).format('MM-DD HH:mm')}` : ''}
                    </div>
                    {active.guestNote && <div style={{ marginTop: 4 }}>客人留言：{active.guestNote}</div>}
                    {active.status === 'proposed' && (
                      <Space style={{ marginTop: 10 }}>
                        <Button type="primary" onClick={() => respond(true)}>客人接受</Button>
                        <Button danger onClick={() => respond(false)}>客人拒绝</Button>
                      </Space>
                    )}
                  </div>} />
              ) : <Alert type="info" showIcon style={{ marginBottom: 12 }} message="尚未做出补救决策" />}
              <Form form={form} layout="vertical" initialValues={{ action: 'voucher', amount: 150 }}
                onFinish={decide}>
                <Form.Item name="action" label="补救方式（四选一，重新决策将作废旧的待回应方案）">
                  <Radio.Group onChange={(ev) => setAction(ev.target.value)}>
                    <Space direction="vertical">
                      <Radio value="refund">退款（金额计入渠道真实获客成本）</Radio>
                      <Radio value="voucher">补偿券（自动生成券码）</Radio>
                      <Radio value="call">电话道歉（不产生金额）</Radio>
                      <Radio value="none">不予补偿（差评事件保持待处理）</Radio>
                    </Space>
                  </Radio.Group>
                </Form.Item>
                <Form.Item noStyle shouldUpdate>
                  {() => (action === 'refund' || action === 'voucher') && (
                    <Form.Item name="amount" label="金额（¥）" rules={[{ required: true, message: '请输入金额' }]}>
                      <InputNumber min={1} style={{ width: '100%' }} />
                    </Form.Item>
                  )}
                </Form.Item>
                <Form.Item name="note" label="补救说明">
                  <Input.TextArea rows={2} placeholder="如：早餐+潮湿+久等综合补救，附致歉卡" />
                </Form.Item>
                <Button type="primary" htmlType="submit" block>下发补救决策</Button>
              </Form>
              {data.remediations.length > 1 && (
                <div style={{ marginTop: 10, fontSize: 12, color: '#999' }}>
                  历史决策：{data.remediations.map((m) =>
                    `${REMEDIATION_ACTIONS[m.action].text}/${REMEDIATION_STATUS[m.status].text}`).join(' → ')}
                </div>
              )}
            </Card>

            <Card size="small" title={<Space><FieldTimeOutlined />补救后改评观察</Space>}>
              {review.monitorStatus === 'revised' ? (
                <Alert type="success" showIcon
                  message={`客人已改评：${review.originalRating} → ${review.rating} 分，渠道评分恢复`}
                  description="本次补救被接受且差评被修改，下次旺季该渠道按正常权重排班与配额。" />
              ) : review.monitorStatus === 'unchanged' ? (
                <Alert type="warning" showIcon message="观察期结束，客人未修改差评"
                  description="补救未带来评分恢复：下次旺季该渠道订单加排缓冲人力，复盘时压缩对应配额。" />
              ) : (
                <>
                  <Alert type="info" showIcon style={{ marginBottom: 10 }}
                    message="补救完成后平台持续观察客人是否修改差评" />
                  <Space direction="vertical" style={{ width: '100%' }}>
                    <Button type="primary" block onClick={() => { setReviseOpen(true); reviseForm.resetFields(); }}>
                      登记客人已修改差评
                    </Button>
                    <Button block onClick={async () => {
                      await api.post(`/reviews/${review.id}/finish-monitor`);
                      message.success('观察结束：客人未改评'); load();
                    }}>观察结束 · 客人未改评</Button>
                  </Space>
                </>
              )}
            </Card>

            <Card size="small" title={<Space><MessageOutlined />补充管家沟通记录</Space>}>
              <Form form={commForm} layout="vertical" initialValues={{ channel: 'wechat', direction: 'outbound', staffName: '管家·小林' }}
                onFinish={async (v) => {
                  await api.post('/comms', { bookingId: review.bookingId, ...v });
                  message.success('沟通记录已追加到复盘时间线');
                  commForm.resetFields();
                  load();
                }}>
                <Space style={{ marginBottom: 8 }}>
                  <Form.Item name="channel" noStyle><Select style={{ width: 90 }} options={Object.entries(COMM_CHANNEL).map(([value, label]) => ({ value, label }))} /></Form.Item>
                  <Form.Item name="direction" noStyle><Select style={{ width: 110 }} options={[{ value: 'outbound', label: '管家发起' }, { value: 'inbound', label: '客人发起' }]} /></Form.Item>
                </Space>
                <Form.Item name="staffName"><Input placeholder="经手人" /></Form.Item>
                <Form.Item name="content" rules={[{ required: true, message: '请输入沟通内容' }]}>
                  <Input.TextArea rows={2} placeholder="沟通内容" />
                </Form.Item>
                <Button block type="primary" htmlType="submit">追加沟通记录</Button>
              </Form>
            </Card>
          </Space>
        </Col>

        <Col span={24}>
          <Card size="small" title="住宿链路统一时间线（沟通 / 除湿 / 保洁 / 早餐 / 事件 / 评价）">
            <Timeline items={timeline.map((t) => ({
              color: KIND_COLOR[t.kind],
              children: <Space size={8} wrap>
                <span style={{ color: '#999', fontSize: 12 }}>{dayjs(t.at).format('MM-DD HH:mm')}</span>
                <Tag>{KIND_LABEL[t.kind]}</Tag>
                <span>{t.text}</span>
              </Space>,
            }))} />
          </Card>
        </Col>
      </Row>

      <Modal title="登记客人修改差评" open={reviseOpen} onCancel={() => setReviseOpen(false)}
        onOk={() => reviseForm.submit()} okText="保存改评" destroyOnClose>
        <Form form={reviseForm} layout="vertical" initialValues={{ rating: 4 }}
          onFinish={async (v) => {
            await api.post(`/reviews/${review.id}/revise`, v);
            message.success('已登记改评，渠道评分恢复');
            setReviseOpen(false); load();
          }}>
          <Form.Item name="rating" label="修改后评分" rules={[{ required: true }]}>
            <Radio.Group>
              {[1, 2, 3, 4, 5].map((n) => <Radio.Button key={n} value={n} style={{ margin: '0 6px 6px 0' }}>{n}分</Radio.Button>)}
            </Radio.Group>
          </Form.Item>
          <Form.Item name="content" label="客人新的评价内容（可选）">
            <Input.TextArea rows={3} />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
