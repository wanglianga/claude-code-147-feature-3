import React, { useEffect, useState } from 'react';
import {
  Alert, Button, Card, Col, Descriptions, Drawer, Empty, Form, Input, InputNumber,
  List, Modal, Popconfirm, Row, Select, Space, Statistic, Table, Tabs, Tag, Timeline, message,
} from 'antd';
import {
  CheckOutlined, CloseOutlined, EyeOutlined, GiftOutlined, PhoneOutlined,
  RollbackOutlined, StopOutlined,
} from '@ant-design/icons';
import dayjs from 'dayjs';
import api, {
  INCIDENT_STATUS, INCIDENT_TYPES, ISSUE_DIMENSIONS, ISSUE_STATUS,
  REMEDIATION_ACTIONS, REMEDIATION_STATUS, REVIEW_CATEGORIES, TASK_STATUS,
} from '../api';

const fmt = (v) => (v ? dayjs(v).format('MM-DD HH:mm') : '-');

export default function ReviewCenter() {
  const [reviews, setReviews] = useState([]);
  const [current, setCurrent] = useState(null); // 复盘页聚合数据
  const [remAction, setRemAction] = useState(null); // 补救方式弹窗
  const [amendOpen, setAmendOpen] = useState(false);
  const [remForm] = Form.useForm();
  const [amendForm] = Form.useForm();

  const load = async () => setReviews(await api.get('/reviews'));
  useEffect(() => { load(); }, []);

  const openRetro = async (r) => setCurrent(await api.get(`/reviews/${r.id}/retrospective`));
  const refresh = async () => {
    await load();
    if (current) setCurrent(await api.get(`/reviews/${current.review.id}/retrospective`));
  };

  const verifyIssue = async (issue, status) => {
    const note = window.prompt(status === 'confirmed' ? '核实结论（对应复盘证据）' : '不成立说明');
    if (note === null) return;
    await api.post(`/review-issues/${issue.id}/verify`, { status, note });
    message.success('归因已核实');
    refresh();
  };

  const remediate = async (v) => {
    await api.post(`/remediations/for-review/${current.review.id}`, { action: remAction, ...v });
    message.success(remAction === 'none' ? '已按不予补偿关闭，继续观察客人反应' : '补救已发起，等待客人回应');
    setRemAction(null);
    refresh();
  };

  const respond = async (accept) => {
    await api.post(`/remediations/${current.remediation.id}/respond`, { accept });
    message.success(accept ? '客人已接受补救，差评事件关闭，进入观察期' : '客人已拒绝，补偿作废，继续观察');
    refresh();
  };

  const amend = async (v) => {
    await api.post(`/reviews/${current.review.id}/amend`, v);
    message.success(v.rating > 3 ? '客人已改回高分，渠道评分恢复，观察结束' : '客人修改了差评，仍为低分，继续观察');
    setAmendOpen(false);
    refresh();
  };

  // 统计：原始评分 ≤3 视为差评
  const bad = reviews.filter((r) => r.originalRating <= 3);
  const stats = {
    bad: bad.length,
    todo: bad.filter((r) => !r.remediation).length,
    pending: reviews.filter((r) => r.remediation?.status === 'pending').length,
    watching: reviews.filter((r) => r.watching).length,
    recovered: bad.filter((r) => r.rating > 3).length,
  };

  const ev = current?.evidence || {};
  const f = current?.findings || {};
  const rem = current?.remediation;

  return (
    <Card title="差评复盘：归因 · 补救 · 观察"
      extra={<span style={{ color: '#888', fontSize: 12 }}>早餐备餐 / 除湿设备 / 保洁完成时间 / 布草延迟 / 管家沟通 同页复盘；补救接受情况进入渠道评分恢复与旺季排班</span>}>
      <Row gutter={16} style={{ marginBottom: 16 }}>
        <Col span={4}><Card size="small"><Statistic title="差评（原始≤3分）" value={stats.bad} /></Card></Col>
        <Col span={4}><Card size="small"><Statistic title="待补救" value={stats.todo} valueStyle={{ color: '#cf1322' }} /></Card></Col>
        <Col span={4}><Card size="small"><Statistic title="待客人回应" value={stats.pending} valueStyle={{ color: '#d46b08' }} /></Card></Col>
        <Col span={4}><Card size="small"><Statistic title="观察中" value={stats.watching} valueStyle={{ color: '#1677ff' }} /></Card></Col>
        <Col span={4}><Card size="small"><Statistic title="已恢复（改回高分）" value={stats.recovered} valueStyle={{ color: '#2f6b4f' }} /></Card></Col>
      </Row>

      <Table dataSource={reviews} rowKey="id" size="middle" pagination={false} columns={[
        { title: '时间', dataIndex: 'createdAt', width: 100, render: (v) => dayjs(v).format('MM-DD HH:mm') },
        { title: '订单', dataIndex: 'bookingCode', width: 100 },
        { title: '客人', dataIndex: 'guestName', width: 100 },
        { title: '渠道', dataIndex: 'channel', width: 90 },
        {
          title: '评分', width: 100, render: (_, r) => (
            r.originalRating !== r.rating
              ? <span><s style={{ color: '#cf1322' }}>{r.originalRating}分</s> → <b style={{ color: '#2f6b4f' }}>{r.rating}分</b></span>
              : <span style={{ color: r.rating <= 3 ? '#cf1322' : '#2f6b4f', fontWeight: 700 }}>{r.rating}分</span>
          ),
        },
        { title: '分类', dataIndex: 'category', width: 80, render: (v) => REVIEW_CATEGORIES[v] },
        {
          title: '归因维度', dataIndex: 'issues', render: (v) => v.length
            ? v.map((i) => <Tag key={i.id} color={ISSUE_STATUS[i.status]?.color}>{ISSUE_DIMENSIONS[i.dimension] || i.dimension}</Tag>)
            : '-',
        },
        {
          title: '补救', width: 130, render: (_, r) => r.remediation
            ? <Tag color={REMEDIATION_STATUS[r.remediation.status]?.color}>
                {REMEDIATION_ACTIONS[r.remediation.action]}·{REMEDIATION_STATUS[r.remediation.status]?.text}
              </Tag>
            : (r.originalRating <= 3 ? <Tag color="red">未补救</Tag> : '-'),
        },
        {
          title: '观察', width: 90, render: (_, r) => (
            r.watching ? <Tag icon={<EyeOutlined />} color="processing">观察中</Tag>
              : r.amendmentCount > 0 ? <Tag color="green">客人已修改</Tag> : '-'
          ),
        },
        { title: '操作', width: 90, render: (_, r) => <Button size="small" type="primary" ghost onClick={() => openRetro(r)}>复盘</Button> },
      ]} />

      <Drawer title={current ? `差评复盘 · ${current.review.guestName}（${current.review.bookingCode}）` : ''}
        open={!!current} onClose={() => setCurrent(null)} width={1040}>
        {current && (
          <div>
            <Alert style={{ marginBottom: 12 }}
              type={current.review.rating <= 3 ? 'error' : 'success'} showIcon
              message={<Space>
                <b>{current.review.originalRating ?? current.review.rating} 分</b>
                {current.review.originalRating !== current.review.rating && <Tag color="green">客人已改为 {current.review.rating} 分</Tag>}
                <Tag>{REVIEW_CATEGORIES[current.review.category]}</Tag>
                {current.review.watching && <Tag icon={<EyeOutlined />} color="processing">观察中</Tag>}
              </Space>}
              description={current.amendments?.length
                ? <>原始评价：{current.amendments[0].oldContent}<br />最新评价：{current.review.content}</>
                : current.review.content} />

            <Descriptions size="small" column={4} bordered style={{ marginBottom: 12 }}
              items={[
                { key: '1', label: '客人', children: current.review.guestName },
                { key: '2', label: '渠道', children: current.review.channel },
                { key: '3', label: '房间', children: `${current.review.room}（${current.booking.roomType?.name}）` },
                { key: '4', label: '住期', children: `${current.booking.checkIn} ~ ${current.booking.checkOut}` },
                { key: '5', label: '实际入住', children: fmt(current.booking.actualCheckIn) },
                { key: '6', label: '实际退房', children: fmt(current.booking.actualCheckOut) },
                { key: '7', label: '早餐', children: `${current.booking.breakfastCount} 份/天` },
                { key: '8', label: '订单金额', children: `¥${current.booking.totalAmount}` },
              ]} />

            <Card size="small" title="归因维度（对照右侧证据核实）" style={{ marginBottom: 12 }}>
              {current.issues.length ? (
                <List size="small" dataSource={current.issues} renderItem={(i) => (
                  <List.Item actions={i.status === 'pending' ? [
                    <Button key="y" size="small" icon={<CheckOutlined />} onClick={() => verifyIssue(i, 'confirmed')}>属实</Button>,
                    <Button key="n" size="small" icon={<CloseOutlined />} onClick={() => verifyIssue(i, 'rejected')}>不成立</Button>,
                  ] : []}>
                    <Space>
                      <Tag color={ISSUE_STATUS[i.status]?.color}>{ISSUE_STATUS[i.status]?.text}</Tag>
                      <b>{ISSUE_DIMENSIONS[i.dimension] || i.dimension}</b>
                      <span>{i.detail}</span>
                      {i.evidenceNote && <span style={{ color: '#888' }}>（{i.evidenceNote}）</span>}
                    </Space>
                  </List.Item>
                )} />
              ) : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="未登记归因维度" />}
              <div style={{ marginTop: 8 }}>
                {f.cleaningLate && <Tag color="volcano">保洁完成晚于 14:00 标准入住时间</Tag>}
                {f.linenDelayed && <Tag color="volcano">住期内存在布草延迟</Tag>}
                {f.breakfastShort && <Tag color="volcano">住期内早餐备餐不足</Tag>}
                {f.equipmentFault && <Tag color="volcano">除湿设备故障记录</Tag>}
                {f.avgButlerResponseMin != null && <Tag color="blue">管家平均响应 {f.avgButlerResponseMin} 分钟</Tag>}
              </div>
            </Card>

            <Card size="small" title="履约证据（同一复盘页）" style={{ marginBottom: 12 }}>
              <Tabs size="small" items={[
                {
                  key: 'breakfast', label: `早餐备餐 (${ev.breakfastPreps?.length || 0})`,
                  children: <Table dataSource={ev.breakfastPreps} rowKey="id" size="small" pagination={false} columns={[
                    { title: '日期', dataIndex: 'date', width: 110 },
                    { title: '需求份数', dataIndex: 'requiredPortions', width: 90 },
                    { title: '实际备餐', dataIndex: 'preparedPortions', width: 90, render: (v, r) => <span style={{ color: v < r.requiredPortions ? '#cf1322' : undefined, fontWeight: v < r.requiredPortions ? 700 : 400 }}>{v}</span> },
                    { title: '状态', dataIndex: 'status', width: 100, render: (v) => <Tag color={v === 'shortage' ? 'red' : 'green'}>{{ planned: '待确认', confirmed: '已确认', shortage: '供应不足' }[v]}</Tag> },
                    { title: '备注', dataIndex: 'note' },
                  ]} />,
                },
                {
                  key: 'equipment', label: `除湿设备 (${ev.equipmentLogs?.length || 0})`,
                  children: <Table dataSource={ev.equipmentLogs} rowKey="id" size="small" pagination={false} columns={[
                    { title: '时间', dataIndex: 'recordedAt', width: 110, render: fmt },
                    { title: '设备', dataIndex: 'device', width: 90 },
                    { title: '湿度', dataIndex: 'humidity', width: 90, render: (v) => <span style={{ color: v > 65 ? '#cf1322' : undefined, fontWeight: v > 65 ? 700 : 400 }}>{v != null ? `${v}%` : '-'}</span> },
                    { title: '状态', dataIndex: 'status', width: 90, render: (v) => <Tag color={v === 'normal' ? 'green' : 'red'}>{{ normal: '正常', fault: '故障', offline: '离线' }[v]}</Tag> },
                    { title: '备注', dataIndex: 'note' },
                  ]} />,
                },
                {
                  key: 'cleaning', label: `保洁完成时间 (${ev.cleaningTasks?.length || 0})`,
                  children: <Table dataSource={ev.cleaningTasks} rowKey="id" size="small" pagination={false} columns={[
                    { title: '日期', dataIndex: 'date', width: 100 },
                    { title: '保洁员', dataIndex: ['assignee', 'name'], width: 110, render: (v) => v || '-' },
                    { title: '计划开始', dataIndex: 'scheduledStart', width: 110, render: fmt },
                    { title: '完成时间', dataIndex: 'finishedAt', width: 140, render: (v, r) => (
                      <Space>{fmt(v)}{v && dayjs(v).isAfter(dayjs(`${r.date}T14:00:00+08:00`)) && <Tag color="red">晚于14:00</Tag>}</Space>
                    ) },
                    { title: '状态', dataIndex: 'status', width: 90, render: (v) => <Tag color={TASK_STATUS[v]?.color}>{TASK_STATUS[v]?.text}</Tag> },
                    { title: '更换布草', dataIndex: 'linenUsed', width: 90, render: (v) => `${v} 套` },
                  ]} />,
                },
                {
                  key: 'linen', label: `布草配送 (${ev.linenDeliveries?.length || 0})`,
                  children: <Table dataSource={ev.linenDeliveries} rowKey="id" size="small" pagination={false} columns={[
                    { title: '品类', dataIndex: 'item', width: 90 },
                    { title: '数量', dataIndex: 'quantity', width: 70 },
                    { title: '应到时间', dataIndex: 'expectedAt', width: 120, render: fmt },
                    { title: '实到时间', dataIndex: 'arrivedAt', width: 120, render: fmt },
                    { title: '状态', dataIndex: 'status', render: (v) => <Tag color={v === 'delayed' ? 'red' : v === 'delivered' ? 'green' : 'blue'}>{{ scheduled: '待送达', delivered: '已送达', delayed: '延迟' }[v]}</Tag> },
                  ]} />,
                },
                {
                  key: 'butler', label: `管家沟通 (${ev.butlerMessages?.length || 0})`,
                  children: ev.butlerMessages?.length ? (
                    <Timeline style={{ marginTop: 8 }} items={ev.butlerMessages.map((m) => ({
                      color: m.direction === 'guest' ? 'red' : 'green',
                      children: <div>
                        <Space size={8}>
                          <Tag color={m.direction === 'guest' ? 'volcano' : 'green'}>{m.direction === 'guest' ? '客人' : '管家'}</Tag>
                          <span style={{ color: '#888', fontSize: 12 }}>{dayjs(m.sentAt).format('MM-DD HH:mm')} · {m.channel} · {m.handlerName}</span>
                        </Space>
                        <div>{m.content}</div>
                      </div>,
                    }))} />
                  ) : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="无沟通记录" />,
                },
                {
                  key: 'incidents', label: `链路事件 (${ev.incidents?.length || 0})`,
                  children: <Table dataSource={ev.incidents} rowKey="id" size="small" pagination={false} columns={[
                    { title: '时间', dataIndex: 'occurredAt', width: 110, render: fmt },
                    { title: '类型', dataIndex: 'type', width: 100, render: (v) => <Tag>{INCIDENT_TYPES[v] || v}</Tag> },
                    { title: '描述', dataIndex: 'description' },
                    { title: '状态', dataIndex: 'status', width: 90, render: (v) => <Tag color={INCIDENT_STATUS[v]?.color}>{INCIDENT_STATUS[v]?.text}</Tag> },
                  ]} />,
                },
              ]} />
            </Card>

            <Card size="small" title="补救决策（退款 / 补偿券 / 电话道歉 / 不予补偿）" style={{ marginBottom: 12 }}
              extra={(!rem || rem.status !== 'pending') && (
                <Space>
                  <Button size="small" icon={<RollbackOutlined />} onClick={() => { setRemAction('refund'); remForm.resetFields(); }}>退款</Button>
                  <Button size="small" icon={<GiftOutlined />} onClick={() => { setRemAction('voucher'); remForm.resetFields(); }}>补偿券</Button>
                  <Button size="small" icon={<PhoneOutlined />} onClick={() => { setRemAction('phone_apology'); remForm.resetFields(); }}>电话道歉</Button>
                  <Popconfirm title="确认不予补偿？将关闭差评事件并继续观察客人反应" onConfirm={() => remediate({ note: '店主复核后决定不予补偿' })}>
                    <Button size="small" danger icon={<StopOutlined />}>不予补偿</Button>
                  </Popconfirm>
                </Space>
              )}>
              {rem ? (
                <div>
                  <Space wrap style={{ marginBottom: 8 }}>
                    <Tag color="blue" style={{ fontSize: 14, padding: '4px 10px' }}>{REMEDIATION_ACTIONS[rem.action]}</Tag>
                    {rem.amount > 0 && <b>¥{rem.amount}</b>}
                    {rem.voucherCode && <Tag color="purple">券码 {rem.voucherCode}</Tag>}
                    <Tag color={REMEDIATION_STATUS[rem.status]?.color}>{REMEDIATION_STATUS[rem.status]?.text}</Tag>
                    <span style={{ color: '#888' }}>{rem.createdBy} · {fmt(rem.createdAt)}</span>
                  </Space>
                  {rem.note && <div style={{ marginBottom: 4 }}>补救说明：{rem.note}</div>}
                  {rem.respondedAt && <div style={{ marginBottom: 4 }}>客人回应（{fmt(rem.respondedAt)}）：{rem.guestNote || '-'}</div>}
                  {rem.status === 'pending' && (
                    <Alert style={{ marginTop: 8 }} type="warning" showIcon message="等待客人回应"
                      description={<Space style={{ marginTop: 8 }}>
                        <Popconfirm title="客人接受该补救？差评事件将关闭并进入观察期" onConfirm={() => respond(true)}>
                          <Button size="small" type="primary">客人接受</Button>
                        </Popconfirm>
                        <Popconfirm title="客人拒绝该补救？补偿将作废，继续观察" onConfirm={() => respond(false)}>
                          <Button size="small" danger>客人拒绝</Button>
                        </Popconfirm>
                      </Space>} />
                  )}
                </div>
              ) : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="尚未发起补救，请在右上角选择补救方式" />}
              {current.remediations?.length > 1 && (
                <div style={{ marginTop: 8, borderTop: '1px dashed #eee', paddingTop: 8 }}>
                  <div style={{ color: '#888', fontSize: 12, marginBottom: 4 }}>历史补救</div>
                  {current.remediations.slice(1).map((m) => (
                    <div key={m.id} style={{ fontSize: 12, color: '#666' }}>
                      · {REMEDIATION_ACTIONS[m.action]}{m.amount > 0 ? ` ¥${m.amount}` : ''} → {REMEDIATION_STATUS[m.status]?.text}（{fmt(m.createdAt)}）
                    </div>
                  ))}
                </div>
              )}
            </Card>

            <Card size="small" title="差评修改观察（补救完成后持续观察客人是否修改差评）"
              extra={current.review.watching && <Button size="small" type="primary" ghost onClick={() => { setAmendOpen(true); amendForm.resetFields(); }}>客人修改了差评</Button>}>
              {current.amendments?.length ? (
                <Timeline items={current.amendments.map((a) => ({
                  color: a.newRating > 3 ? 'green' : 'orange',
                  children: <div>
                    <Space size={8}>
                      <s style={{ color: '#cf1322' }}>{a.oldRating}分</s> → <b style={{ color: a.newRating > 3 ? '#2f6b4f' : '#cf1322' }}>{a.newRating}分</b>
                      <span style={{ color: '#888', fontSize: 12 }}>{fmt(a.amendedAt)}</span>
                    </Space>
                    <div style={{ fontSize: 12, color: '#666' }}>{a.newContent}</div>
                  </div>,
                }))} />
              ) : (
                <span style={{ color: '#888' }}>
                  {current.review.watching ? '观察中：客人尚未修改差评，平台将持续关注' : '客人暂无修改记录'}
                </span>
              )}
            </Card>
          </div>
        )}
      </Drawer>

      <Modal title={`发起补救：${remAction ? REMEDIATION_ACTIONS[remAction] : ''}`} open={!!remAction}
        onCancel={() => setRemAction(null)} onOk={() => remForm.submit()} okText="发起补救" destroyOnClose>
        <Form form={remForm} layout="vertical" onFinish={remediate}
          initialValues={{ amount: remAction === 'voucher' ? 100 : 200 }}>
          {['refund', 'voucher'].includes(remAction) && (
            <Form.Item name="amount" label={remAction === 'refund' ? '退款金额（¥）' : '补偿券面额（¥）'} rules={[{ required: true, message: '金额必填' }]}>
              <InputNumber min={1} style={{ width: '100%' }} />
            </Form.Item>
          )}
          <Form.Item name="note" label="补救说明">
            <Input.TextArea rows={2} placeholder={remAction === 'phone_apology' ? '如：店主致电致歉，承诺检修除湿机并加强保洁' : '如：针对入住等待与房间潮湿的补偿'} />
          </Form.Item>
          {remAction === 'voucher' && <Alert type="info" showIcon message="补偿券将自动生成券码，客人接受后计入该渠道真实获客成本" />}
          {remAction === 'refund' && <Alert type="info" showIcon message="退款将计入结算支出与该渠道真实获客成本" />}
          {remAction === 'phone_apology' && <Alert type="info" showIcon message="电话道歉不产生补偿成本，客人回应后进入观察期" />}
        </Form>
      </Modal>

      <Modal title="客人修改差评（平台观察）" open={amendOpen} onCancel={() => setAmendOpen(false)}
        onOk={() => amendForm.submit()} okText="登记修改" destroyOnClose>
        <Form form={amendForm} layout="vertical" onFinish={amend} initialValues={{ rating: 4 }}>
          <Form.Item name="rating" label="修改后评分" rules={[{ required: true }]}>
            <Select options={[1, 2, 3, 4, 5].map((v) => ({ value: v, label: `${v} 分${v > 3 ? '（改回高分，观察结束）' : ''}` }))} />
          </Form.Item>
          <Form.Item name="content" label="修改后评价内容">
            <Input.TextArea rows={3} placeholder="客人更新后的评价内容" />
          </Form.Item>
        </Form>
      </Modal>
    </Card>
  );
}
