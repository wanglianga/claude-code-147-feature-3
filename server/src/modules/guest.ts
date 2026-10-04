import {
  BadRequestException, Body, Controller, Get, Module, NotFoundException, Param, Post, Query,
} from '@nestjs/common';
import { InjectRepository, TypeOrmModule } from '@nestjs/typeorm';
import { Between, DataSource, In, Repository } from 'typeorm';
import {
  Booking, BreakfastPrep, CleaningTask, Compensation, Equipment, EquipmentLog, GuestComm,
  Incident, LinenDelivery, MaintenanceTicket, Remediation, Review, Room,
} from '../entities';
import { CurrentUser } from '../common/auth';
import { addDays, round2 } from '../common/util';

const REVIEW_TAGS: Record<string, string> = {
  breakfast: '早餐少', damp: '房间潮湿', wait: '入住等待久', linen: '布草延迟', cleaning: '保洁完成晚',
};
const REMEDIATION_ACTIONS: Record<string, string> = {
  refund: '退款', voucher: '补偿券', call: '电话道歉', none: '不予补偿',
};
// 容器默认 UTC，统一按北京时间（UTC+8）展示
const fmtCN = (d: Date | string) => new Date(d).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });

// ================= 事件（住宿链路统一记录） =================
@Controller('incidents')
export class IncidentsController {
  constructor(
    @InjectRepository(Incident) private incidents: Repository<Incident>,
    @InjectRepository(Booking) private bookings: Repository<Booking>,
    @InjectRepository(Room) private rooms: Repository<Room>,
    @InjectRepository(MaintenanceTicket) private maintenance: Repository<MaintenanceTicket>,
    private dataSource: DataSource,
  ) {}

  @Get()
  list(@Query('type') type?: string, @Query('status') status?: string) {
    const where: any = {};
    if (type) where.type = type;
    if (status) where.status = status;
    return this.incidents.find({ where, order: { occurredAt: 'DESC' } });
  }

  // 手工登记事件；宠物损坏会同步扣押金+建维修单，空调故障会同步建维修单+房态转维修
  @Post()
  async create(@Body() body: {
    type: string; bookingId?: number; roomId?: number; description: string; cost?: number;
  }) {
    if (!body.type || !body.description) throw new BadRequestException('事件类型与描述必填');
    const cost = body.cost || 0;
    return this.dataSource.transaction(async (em) => {
      const incident = await em.save(em.create(Incident, {
        type: body.type, bookingId: body.bookingId || null, roomId: body.roomId || null,
        description: body.description, status: 'open', cost,
      }));
      if (body.type === 'pet_damage') {
        if (body.bookingId) {
          const b = await em.findOne(Booking, { where: { id: body.bookingId } });
          if (b) {
            b.depositDeducted = round2(Math.min(Number(b.depositAmount), Number(b.depositDeducted) + cost));
            await em.save(b);
          }
        }
        if (body.roomId) {
          await em.save(em.create(MaintenanceTicket, {
            roomId: body.roomId, bookingId: body.bookingId || null, type: 'furniture',
            description: `宠物损坏：${body.description}`, status: 'open', cost,
          }));
        }
      }
      if (body.type === 'ac_failure' && body.roomId) {
        await em.save(em.create(MaintenanceTicket, {
          roomId: body.roomId, bookingId: body.bookingId || null, type: 'ac',
          description: `空调故障：${body.description}`, status: 'open', cost: 0,
        }));
        await em.update(Room, body.roomId, { status: 'maintenance' });
      }
      return incident;
    });
  }

  @Post(':id/resolve')
  async resolve(@Param('id') id: number, @Body() body: { resolution?: string; cost?: number }) {
    const it = await this.incidents.findOne({ where: { id } });
    if (!it) throw new NotFoundException('事件不存在');
    it.status = 'resolved';
    it.resolvedAt = new Date();
    it.resolution = body.resolution || '';
    if (body.cost !== undefined) it.cost = body.cost;
    return this.incidents.save(it);
  }
}

// ================= 差评 =================
@Controller('reviews')
export class ReviewsController {
  constructor(
    @InjectRepository(Review) private reviews: Repository<Review>,
    @InjectRepository(Booking) private bookings: Repository<Booking>,
    @InjectRepository(Incident) private incidents: Repository<Incident>,
    @InjectRepository(Remediation) private remediations: Repository<Remediation>,
    @InjectRepository(Compensation) private compensations: Repository<Compensation>,
    @InjectRepository(BreakfastPrep) private preps: Repository<BreakfastPrep>,
    @InjectRepository(CleaningTask) private cleaning: Repository<CleaningTask>,
    @InjectRepository(LinenDelivery) private deliveries: Repository<LinenDelivery>,
    @InjectRepository(Equipment) private equipments: Repository<Equipment>,
    @InjectRepository(EquipmentLog) private equipLogs: Repository<EquipmentLog>,
    @InjectRepository(GuestComm) private comms: Repository<GuestComm>,
    private dataSource: DataSource,
  ) {}

  @Get()
  async list() {
    const rows = await this.reviews.find({ relations: ['booking', 'booking.channel', 'booking.room'], order: { id: 'DESC' } });
    const rems = await this.remediations.find({ order: { id: 'ASC' } });
    return rows.map((r) => {
      const history = rems.filter((m) => m.reviewId === r.id);
      const active = [...history].reverse().find((m) => m.status !== 'void') || null;
      return {
        ...r,
        tagsList: r.tags ? r.tags.split(',').filter(Boolean) : [],
        bookingCode: r.booking?.code,
        guestName: r.booking?.guestName,
        channel: (r.booking as any)?.channel?.name,
        room: (r.booking as any)?.room?.code,
        remediation: active,
        remediationActions: history,
      };
    });
  }

  // 登记评价；≤3 分自动生成差评事件进入住宿链路，可带复盘归因标签
  @Post()
  async create(@Body() body: { bookingId: number; rating: number; category: string; content: string; tags?: string[] }) {
    const b = await this.bookings.findOne({ where: { id: body.bookingId } });
    if (!b) throw new NotFoundException('订单不存在');
    if (!body.rating || body.rating < 1 || body.rating > 5) throw new BadRequestException('评分需为 1-5');
    if (!['hardware', 'service', 'oversell', 'food'].includes(body.category)) {
      throw new BadRequestException('分类需为 hardware/service/oversell/food');
    }
    const tags = (body.tags || []).filter((t) => REVIEW_TAGS[t]);
    return this.dataSource.transaction(async (em) => {
      const review = await em.save(em.create(Review, {
        bookingId: b.id, rating: body.rating, originalRating: body.rating, category: body.category,
        tags: tags.join(','), content: body.content || '',
        monitorStatus: body.rating <= 3 ? 'observing' : 'none',
      }));
      if (body.rating <= 3) {
        const tagText = tags.length ? `，归因：${tags.map((t) => REVIEW_TAGS[t]).join('、')}` : '';
        await em.save(em.create(Incident, {
          type: 'bad_review', bookingId: b.id, roomId: b.roomId,
          description: `差评（${body.rating}分/${body.category}${tagText}）：${body.content}`,
          status: 'open', cost: 0,
        }));
      }
      return review;
    });
  }

  // 差评复盘页：早餐备餐、除湿设备、保洁完成时间、布草延迟、管家沟通放在同一页
  @Get(':id/replay')
  async replay(@Param('id') id: number) {
    const review = await this.reviews.findOne({ where: { id }, relations: ['booking', 'booking.channel', 'booking.room'] });
    if (!review) throw new NotFoundException('评价不存在');
    const b = review.booking;
    const stayFrom = b.checkIn;
    const stayTo = b.checkOut;
    const windowFrom = addDays(stayFrom, -1);
    const windowTo = addDays(stayTo, 1);
    // 早餐供应日：入住次日 ~ 离店当日
    const serveFrom = addDays(stayFrom, 1);

    const [prepRows, equipLogs, equipAll, tasks, allIncidents, deliveries, comms, rems, comps] = await Promise.all([
      this.preps.find({ where: { date: Between(serveFrom, stayTo) }, order: { date: 'ASC' } }),
      this.equipLogs.find({
        where: [{ bookingId: b.id }, { roomId: b.roomId, date: Between(windowFrom, windowTo) }],
        relations: ['equipment'], order: { recordedAt: 'ASC' },
      }),
      this.equipments.find(),
      this.cleaning.find({
        where: [{ bookingId: b.id }, { roomId: b.roomId, date: Between(windowFrom, windowTo) }],
        relations: ['assignee'], order: { date: 'ASC' },
      }),
      this.incidents.find({ order: { occurredAt: 'ASC' } }),
      this.deliveries.find({ order: { expectedAt: 'ASC' } }),
      this.comms.find({ where: { bookingId: b.id }, order: { at: 'ASC' } }),
      this.remediations.find({ where: { reviewId: review.id }, order: { id: 'ASC' } }),
      this.compensations.find({ where: { reviewId: review.id }, order: { id: 'ASC' } }),
    ]);

    const stayIncidents = allIncidents.filter((i) => i.bookingId === b.id);
    const linenIncidents = allIncidents.filter((i) => i.type === 'linen_delay'
      && i.occurredAt.toISOString().slice(0, 10) >= windowFrom
      && i.occurredAt.toISOString().slice(0, 10) <= windowTo);

    // —— 早餐证据 ——
    const breakfastRows = prepRows.map((p) => ({
      date: p.date, required: p.requiredPortions, prepared: p.preparedPortions,
      gap: Math.max(0, p.requiredPortions - p.preparedPortions),
      status: p.status, note: p.note || '',
    }));
    const shortageDays = breakfastRows.filter((p) => p.gap > 0);
    const breakfast = {
      portions: b.breakfastCount, dietary: b.dietaryNotes || '',
      rows: breakfastRows,
      incidents: stayIncidents.filter((i) => i.type === 'breakfast_shortage'),
      summary: shortageDays.length
        ? `住店期间 ${shortageDays.length} 个早餐供应日备餐不足（${shortageDays.map((p) => `${p.date} 缺${p.gap}份`).join('、')}）`
        : '住店期间备餐量满足需求',
    };

    // —— 除湿设备证据 ——
    const abnormalLogs = equipLogs.filter((l) => l.status === 'abnormal');
    const maxHumidity = equipLogs.reduce((m, l) => Math.max(m, l.humidity || 0), 0);
    const equipment = {
      devices: equipAll.filter((e) => e.roomId === b.roomId || abnormalLogs.some((l) => l.equipmentId === e.id)),
      logs: equipLogs, abnormalCount: abnormalLogs.length, maxHumidity,
      summary: abnormalLogs.length
        ? `住店期间除湿设备 ${abnormalLogs.length} 次异常，房间记录最高湿度 ${maxHumidity}%`
        : '除湿设备运行正常',
    };

    // —— 保洁完成时间证据（入住日 14:00 为截止线）——
    const cleaningRows = tasks.map((t) => {
      const deadline = `${t.date}T14:00:00+08:00`;
      const lateMins = t.finishedAt
        ? Math.max(0, Math.round((new Date(t.finishedAt).getTime() - new Date(deadline).getTime()) / 60000))
        : null;
      return {
        id: t.id, date: t.date, dirtiness: t.dirtiness, status: t.status,
        assignee: t.assignee?.name || null, linenUsed: t.linenUsed,
        scheduledStart: t.scheduledStart, startedAt: t.startedAt, finishedAt: t.finishedAt,
        finishedLateMins: lateMins, notes: t.notes || '',
      };
    });
    const readyTask = cleaningRows
      .filter((t) => t.finishedAt && t.date <= stayFrom)
      .sort((x, y) => (x.finishedAt! < y.finishedAt! ? 1 : -1))[0] || null;
    const checkInDeadline = `${stayFrom}T14:00:00+08:00`;
    const checkInWaitMins = b.actualCheckIn
      ? Math.max(0, Math.round((new Date(b.actualCheckIn).getTime() - new Date(checkInDeadline).getTime()) / 60000))
      : null;
    const cleaning = {
      tasks: cleaningRows,
      checkInAt: b.actualCheckIn, checkInWaitMins,
      roomReadyAt: readyTask?.finishedAt || null,
      roomReadyLateMins: readyTask?.finishedLateMins ?? null,
      summary: [
        checkInWaitMins
          ? `客人 ${fmtCN(b.actualCheckIn!)} 入住，相对 14:00 截止线等待 ${checkInWaitMins} 分钟`
          : '',
        readyTask?.finishedLateMins
          ? `入住前保洁 ${fmtCN(readyTask.finishedAt)} 才完成，超截止线 ${readyTask.finishedLateMins} 分钟`
          : '',
      ].filter(Boolean).join('；') || '保洁按时完成，客人准时入住',
    };

    // —— 布草延迟证据 ——
    const delayedDeliveries = deliveries.filter((d) => d.status === 'delayed'
      && new Date(d.expectedAt).toISOString().slice(0, 10) >= windowFrom
      && new Date(d.expectedAt).toISOString().slice(0, 10) <= windowTo);
    const linen = {
      delays: linenIncidents, deliveries: delayedDeliveries,
      summary: linenIncidents.length
        ? `住宿窗口内发生 ${linenIncidents.length} 起布草延迟，换布与保洁周转受限`
        : '住宿窗口内无布草延迟',
    };

    // —— 统一时间线 ——
    const timeline: any[] = [];
    for (const c of comms) timeline.push({ at: c.at, kind: 'comm', text: `管家沟通（${c.staffName || '管家'}）：${c.content}` });
    for (const l of equipLogs) {
      timeline.push({
        at: l.recordedAt, kind: 'equipment',
        text: `除湿设备 ${l.equipment?.code || ''} ${l.status === 'abnormal' ? `异常：${l.note}` : '恢复正常'}${l.humidity ? `（湿度 ${l.humidity}%）` : ''}`,
      });
    }
    for (const t of tasks) {
      if (t.scheduledStart) {
        timeline.push({ at: t.scheduledStart, kind: 'cleaning', text: `保洁排班：${t.assignee?.name || '保洁员'}，${t.dirtiness === 'heavy' ? '重污' : t.dirtiness === 'light' ? '轻污' : '常规'}` });
      }
      if (t.finishedAt) {
        timeline.push({ at: t.finishedAt, kind: 'cleaning', text: `保洁完成（${t.assignee?.name || ''}）${t.linenUsed ? `，更换布草 ${t.linenUsed} 套` : ''}` });
      }
    }
    for (const p of breakfastRows) {
      timeline.push({ at: `${p.date}T08:30:00+08:00`, kind: 'breakfast', text: `早餐备餐：需求 ${p.required} 份 / 实备 ${p.prepared} 份${p.gap ? `，缺口 ${p.gap} 份` : ''}` });
    }
    for (const i of [...stayIncidents, ...linenIncidents]) {
      timeline.push({ at: i.occurredAt, kind: 'incident', text: `事件：${i.description}` });
    }
    timeline.push({ at: review.createdAt, kind: 'review', text: `客人评价 ${review.rating} 分：${review.content}` });
    timeline.sort((x, y) => new Date(x.at).getTime() - new Date(y.at).getTime());

    return {
      review: {
        ...review,
        tagsList: review.tags ? review.tags.split(',').filter(Boolean) : [],
        bookingCode: b.code, guestName: b.guestName,
        channel: (b as any).channel?.name, channelId: b.channelId,
        room: (b as any).room?.code,
        checkIn: b.checkIn, checkOut: b.checkOut, dietaryNotes: b.dietaryNotes,
      },
      evidence: { breakfast, equipment, cleaning, linen, comms },
      incidents: stayIncidents,
      timeline,
      remediations: rems,
      compensations: comps,
      tagNames: REVIEW_TAGS,
      actionNames: REMEDIATION_ACTIONS,
    };
  }

  // 客人修改差评（补救后平台持续观察的结果）
  @Post(':id/revise')
  async revise(@Param('id') id: number, @Body() body: { rating: number; content?: string }) {
    const r = await this.reviews.findOne({ where: { id } });
    if (!r) throw new NotFoundException('评价不存在');
    if (!body.rating || body.rating < 1 || body.rating > 5) throw new BadRequestException('评分需为 1-5');
    if (r.originalRating === null) r.originalRating = r.rating;
    r.revisedRating = body.rating;
    r.rating = body.rating;
    if (body.content !== undefined) r.revisedContent = body.content;
    r.revisedAt = new Date();
    r.monitorStatus = 'revised';
    return this.reviews.save(r);
  }

  // 观察期结束客人未改评
  @Post(':id/finish-monitor')
  async finishMonitor(@Param('id') id: number) {
    const r = await this.reviews.findOne({ where: { id } });
    if (!r) throw new NotFoundException('评价不存在');
    r.monitorStatus = 'unchanged';
    r.monitoredAt = new Date();
    return this.reviews.save(r);
  }
}

// ================= 店主补救决策 =================
@Controller('remediations')
export class RemediationsController {
  constructor(
    @InjectRepository(Remediation) private remediations: Repository<Remediation>,
    @InjectRepository(Review) private reviews: Repository<Review>,
    @InjectRepository(Booking) private bookings: Repository<Booking>,
    @InjectRepository(Compensation) private compensations: Repository<Compensation>,
    @InjectRepository(Incident) private incidents: Repository<Incident>,
    private dataSource: DataSource,
  ) {}

  @Get()
  list() {
    return this.remediations.find({ order: { id: 'DESC' } });
  }

  // 店主对差评选择：退款 / 补偿券 / 电话道歉 / 不予补偿；决策后进入客人回应与改评观察
  @Post('for-review/:reviewId')
  async decide(@Param('reviewId') reviewId: number,
               @Body() body: { action: string; amount?: number; note?: string },
               @CurrentUser() user: any) {
    const review = await this.reviews.findOne({ where: { id: reviewId } });
    if (!review) throw new NotFoundException('评价不存在');
    const { action } = body;
    if (!['refund', 'voucher', 'call', 'none'].includes(action)) {
      throw new BadRequestException('补救方式需为 refund/voucher/call/none');
    }
    const amount = round2(body.amount || 0);
    if ((action === 'refund' || action === 'voucher') && amount <= 0) {
      throw new BadRequestException('退款/补偿券金额需大于 0');
    }
    if ((action === 'call' || action === 'none') && body.amount) {
      throw new BadRequestException('电话道歉/不予补偿不产生金额');
    }
    const booking = await this.bookings.findOne({ where: { id: review.bookingId } });
    if (!booking) throw new NotFoundException('订单不存在');

    return this.dataSource.transaction(async (em) => {
      // 同一差评新决策作废旧的待回应决策，并作废其已生成但尚未兑现的补偿
      const stale = await em.find(Remediation, { where: { reviewId, status: 'proposed' } });
      for (const s of stale) s.status = 'void';
      if (stale.length) await em.save(stale);
      const staleIds = stale.map((s) => s.id);
      if (staleIds.length) {
        await em.update(Compensation, { remediationId: In(staleIds), status: 'issued' }, { status: 'cancelled' });
      }

      const voucherCode = action === 'voucher'
        ? 'VC' + Math.random().toString(36).slice(2, 8).toUpperCase()
        : null;
      const rem = await em.save(em.create(Remediation, {
        reviewId: review.id, bookingId: booking.id, channelId: booking.channelId,
        action, amount, voucherCode, note: body.note || '',
        status: action === 'none' ? 'closed' : 'proposed',
        decidedBy: user?.name || user?.username || '',
        guestRespondedAt: action === 'none' ? new Date() : null,
      }));

      if (action === 'refund' || action === 'voucher') {
        await em.save(em.create(Compensation, {
          reviewId: review.id, remediationId: rem.id, bookingId: booking.id,
          type: action, amount, voucherCode, status: 'issued',
          reason: `差评补救·${REMEDIATION_ACTIONS[action]}${body.note ? `：${body.note}` : ''}`,
        }));
        review.compensated = true;
      }
      // 决策后平台继续观察客人是否修改差评
      review.monitorStatus = 'observing';
      await em.save(review);

      // 差评事件：退款/券进入处理中（客人接受后关闭）；不予补偿保持/重回待处理
      if (action !== 'none') {
        await em.update(Incident, { bookingId: booking.id, type: 'bad_review', status: 'open' }, {
          status: 'processing',
          resolution: `店主决定${REMEDIATION_ACTIONS[action]}${amount ? ` ¥${amount}` : ''}，等待客人回应`,
        });
      } else {
        await em.update(Incident, { bookingId: booking.id, type: 'bad_review', status: 'processing' }, {
          status: 'open', resolvedAt: null,
          resolution: body.note ? `店主决定不予补偿：${body.note}` : '店主决定不予补偿',
        });
      }
      return rem;
    });
  }

  // 客人是否接受补救（渠道评分恢复与下次旺季排班参考此结果）
  @Post(':id/respond')
  async respond(@Param('id') id: number, @Body() body: { accepted: boolean; note?: string }) {
    const rem = await this.remediations.findOne({ where: { id } });
    if (!rem) throw new NotFoundException('补救单不存在');
    if (rem.status !== 'proposed') throw new BadRequestException('该补救单已处理或已作废');
    rem.status = body.accepted ? 'accepted' : 'rejected';
    rem.guestRespondedAt = new Date();
    rem.guestNote = body.note || '';
    await this.remediations.save(rem);

    if (body.accepted) {
      await this.incidents.update(
        { bookingId: rem.bookingId, type: 'bad_review', status: 'processing' },
        {
          status: 'resolved', resolvedAt: new Date(),
          resolution: `客人已接受${REMEDIATION_ACTIONS[rem.action]}${rem.amount ? ` ¥${rem.amount}` : ''}${body.note ? `（${body.note}）` : ''}`,
        },
      );
    } else {
      // 客人拒绝：未兑现的退款/补偿券作废，不计入渠道真实获客成本
      await this.compensations.update(
        { remediationId: rem.id, status: 'issued' },
        { status: 'cancelled' },
      );
      await this.incidents.update(
        { bookingId: rem.bookingId, type: 'bad_review', status: 'processing' },
        { status: 'open', resolution: `客人拒绝${REMEDIATION_ACTIONS[rem.action]}${body.note ? `：${body.note}` : ''}，需重新补救` },
      );
    }
    return rem;
  }
}

// ================= 补偿（旧链路保留：现金/券/退款直接发放） =================
@Controller('compensations')
export class CompensationsController {
  constructor(
    @InjectRepository(Compensation) private compensations: Repository<Compensation>,
  ) {}

  @Get()
  list() {
    return this.compensations.find({ order: { id: 'DESC' } });
  }

  // 补偿券核销
  @Post(':id/use')
  async use(@Param('id') id: number) {
    const c = await this.compensations.findOne({ where: { id } });
    if (!c) throw new NotFoundException('补偿记录不存在');
    if (c.type !== 'voucher') throw new BadRequestException('仅补偿券可核销');
    if (c.status !== 'issued') throw new BadRequestException('该券已核销或作废');
    c.status = 'used';
    return this.compensations.save(c);
  }
}

// ================= 管家沟通记录 =================
@Controller('comms')
export class CommsController {
  constructor(
    @InjectRepository(GuestComm) private comms: Repository<GuestComm>,
    @InjectRepository(Booking) private bookings: Repository<Booking>,
  ) {}

  @Get()
  list(@Query('bookingId') bookingId?: number) {
    return this.comms.find({
      where: bookingId ? { bookingId } : {},
      relations: ['booking'], order: { at: 'DESC' },
    });
  }

  @Post()
  async create(@Body() body: {
    bookingId: number; channel?: string; direction?: string; at?: string; content: string; staffName?: string;
  }) {
    if (!body.bookingId || !body.content) throw new BadRequestException('订单与沟通内容必填');
    const b = await this.bookings.findOne({ where: { id: body.bookingId } });
    if (!b) throw new NotFoundException('订单不存在');
    return this.comms.save(this.comms.create({
      bookingId: b.id,
      channel: ['face', 'phone', 'wechat'].includes(body.channel || '') ? body.channel : 'wechat',
      direction: body.direction === 'inbound' ? 'inbound' : 'outbound',
      at: body.at ? new Date(body.at) : new Date(),
      content: body.content, staffName: body.staffName || '',
    }));
  }
}

// ================= 除湿设备 =================
@Controller('equipment')
export class EquipmentController {
  constructor(
    @InjectRepository(Equipment) private items: Repository<Equipment>,
    @InjectRepository(EquipmentLog) private logs: Repository<EquipmentLog>,
  ) {}

  @Get()
  list() {
    return this.items.find({ relations: ['room'], order: { id: 'ASC' } });
  }

  @Post()
  create(@Body() body: { code: string; name: string; roomId?: number }) {
    if (!body.code || !body.name) throw new BadRequestException('设备编号与名称必填');
    return this.items.save(this.items.create({
      code: body.code, name: body.name, type: 'dehumidifier', roomId: body.roomId || null,
    }));
  }

  @Get('logs')
  logList(@Query('bookingId') bookingId?: number, @Query('roomId') roomId?: number) {
    const where: any = {};
    if (bookingId) where.bookingId = bookingId;
    if (roomId) where.roomId = roomId;
    return this.logs.find({ relations: ['equipment'], where, order: { recordedAt: 'DESC' } });
  }

  // 登记除湿设备巡检/异常（异常将作为"房间潮湿"差评的复盘证据）
  @Post('logs')
  async addLog(@Body() body: {
    equipmentId: number; roomId?: number; bookingId?: number; date: string;
    status?: string; humidity?: number; note?: string; recordedAt?: string;
  }) {
    const eq = await this.items.findOne({ where: { id: body.equipmentId } });
    if (!eq) throw new NotFoundException('设备不存在');
    if (!body.date) throw new BadRequestException('日期必填');
    const log = await this.logs.save(this.logs.create({
      equipmentId: eq.id, roomId: body.roomId || eq.roomId, bookingId: body.bookingId || null,
      date: body.date, status: body.status === 'abnormal' ? 'abnormal' : 'normal',
      humidity: body.humidity ?? null, note: body.note || '',
      recordedAt: body.recordedAt ? new Date(body.recordedAt) : new Date(),
    }));
    eq.status = body.status === 'abnormal' ? 'abnormal' : 'normal';
    await this.items.save(eq);
    return log;
  }
}

@Module({
  imports: [TypeOrmModule.forFeature([
    Incident, Booking, Room, MaintenanceTicket, Review, Compensation, Remediation,
    GuestComm, Equipment, EquipmentLog, BreakfastPrep, CleaningTask, LinenDelivery,
  ])],
  controllers: [
    IncidentsController, ReviewsController, CompensationsController,
    RemediationsController, CommsController, EquipmentController,
  ],
})
export class GuestModule {}
