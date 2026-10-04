import {
  BadRequestException, Body, Controller, Get, Module, NotFoundException, Param, Post, Query,
} from '@nestjs/common';
import { InjectRepository, TypeOrmModule } from '@nestjs/typeorm';
import { Between, DataSource, Repository } from 'typeorm';
import {
  Booking, BreakfastPrep, ButlerMessage, CleaningTask, Compensation, EquipmentLog,
  Incident, LinenDelivery, MaintenanceTicket, Remediation, Review, ReviewAmendment,
  ReviewIssue, Room,
} from '../entities';
import { CurrentUser, Roles } from '../common/auth';
import { addDays, round2 } from '../common/util';

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
    @InjectRepository(ReviewIssue) private issues: Repository<ReviewIssue>,
    @InjectRepository(Remediation) private remediations: Repository<Remediation>,
    @InjectRepository(ReviewAmendment) private amendments: Repository<ReviewAmendment>,
    @InjectRepository(BreakfastPrep) private preps: Repository<BreakfastPrep>,
    @InjectRepository(EquipmentLog) private equipmentLogs: Repository<EquipmentLog>,
    @InjectRepository(CleaningTask) private cleaning: Repository<CleaningTask>,
    @InjectRepository(LinenDelivery) private deliveries: Repository<LinenDelivery>,
    @InjectRepository(ButlerMessage) private messages: Repository<ButlerMessage>,
    private dataSource: DataSource,
  ) {}

  @Get()
  async list() {
    const rows = await this.reviews.find({ relations: ['booking', 'booking.channel', 'booking.room'], order: { id: 'DESC' } });
    const [allIssues, allRems, allAmends] = await Promise.all([
      this.issues.find(), this.remediations.find({ order: { id: 'DESC' } }), this.amendments.find(),
    ]);
    return rows.map((r) => {
      const rems = allRems.filter((m) => m.reviewId === r.id);
      const amends = allAmends.filter((a) => a.reviewId === r.id);
      const firstAmend = amends.sort((a, b) => a.id - b.id)[0];
      return {
        ...r,
        bookingCode: r.booking?.code,
        guestName: r.booking?.guestName,
        channel: (r.booking as any)?.channel?.name,
        room: (r.booking as any)?.room?.code,
        issues: allIssues.filter((i) => i.reviewId === r.id),
        remediation: rems[0] || null, // 最新一条补救
        remediationCount: rems.length,
        amendmentCount: amends.length,
        originalRating: firstAmend ? firstAmend.oldRating : r.rating, // 客人修改前的原始评分
      };
    });
  }

  // 登记评价；≤3 分自动生成差评事件进入住宿链路；可带多维归因（早餐少/房间潮湿/入住等待久…）
  @Post()
  async create(@Body() body: { bookingId: number; rating: number; category: string; content: string; issues?: string[] }) {
    const b = await this.bookings.findOne({ where: { id: body.bookingId } });
    if (!b) throw new NotFoundException('订单不存在');
    if (!body.rating || body.rating < 1 || body.rating > 5) throw new BadRequestException('评分需为 1-5');
    if (!['hardware', 'service', 'oversell', 'food'].includes(body.category)) {
      throw new BadRequestException('分类需为 hardware/service/oversell/food');
    }
    return this.dataSource.transaction(async (em) => {
      const review = await em.save(em.create(Review, {
        bookingId: b.id, rating: body.rating, category: body.category, content: body.content || '',
      }));
      for (const dim of body.issues || []) {
        await em.save(em.create(ReviewIssue, { reviewId: review.id, dimension: dim }));
      }
      if (body.rating <= 3) {
        await em.save(em.create(Incident, {
          type: 'bad_review', bookingId: b.id, roomId: b.roomId,
          description: `差评（${body.rating}分/${body.category}）：${body.content}`,
          status: 'open', cost: 0,
        }));
      }
      return review;
    });
  }

  // 差评复盘页：早餐备餐/除湿设备/保洁完成时间/布草延迟/管家沟通记录 同页聚合
  @Get(':id/retrospective')
  async retrospective(@Param('id') id: number) {
    const review = await this.reviews.findOne({
      where: { id }, relations: ['booking', 'booking.channel', 'booking.room', 'booking.roomType'],
    });
    if (!review) throw new NotFoundException('评价不存在');
    const b = review.booking;
    const stayFrom = b.checkIn;
    const stayTo = b.checkOut;
    const [issues, rems, amends, preps, equip, cleaningTasks, deliveries, messages, incidents] =
      await Promise.all([
        this.issues.find({ where: { reviewId: id }, order: { id: 'ASC' } }),
        this.remediations.find({ where: { reviewId: id }, order: { id: 'DESC' } }),
        this.amendments.find({ where: { reviewId: id }, order: { id: 'ASC' } }),
        // 早餐备餐：入住日至离店日的备餐记录
        this.preps.find({ where: { date: Between(stayFrom, stayTo) }, order: { date: 'ASC' } }),
        // 除湿等设备：该房间在住前 1 天至离店日的运行记录
        this.equipmentLogs.find({
          where: { roomId: b.roomId, recordedAt: Between(new Date(addDays(stayFrom, -1)), new Date(stayTo + 'T23:59:59')) },
          order: { recordedAt: 'ASC' },
        }),
        // 保洁：该房间入住前 3 天起的任务（看完成时间是否晚于标准入住 14:00）
        this.cleaning.find({
          where: { roomId: b.roomId, date: Between(addDays(stayFrom, -3), stayTo) },
          relations: ['assignee'], order: { date: 'ASC' },
        }),
        // 布草配送：入住前 2 天至离店日
        this.deliveries.find({
          where: { expectedAt: Between(new Date(addDays(stayFrom, -2)), new Date(stayTo + 'T23:59:59')) },
          order: { expectedAt: 'ASC' },
        }),
        this.messages.find({ where: { bookingId: b.id }, order: { sentAt: 'ASC' } }),
        this.incidents.find({ order: { occurredAt: 'ASC' } }),
      ]);
    // 链路事件：本订单的 + 住期内的全局事件（早餐不足/布草延迟等 bookingId 为空）
    const relatedIncidents = incidents.filter((i) =>
      i.bookingId === b.id
      || (i.bookingId === null && new Date(i.occurredAt) >= new Date(stayFrom) && new Date(i.occurredAt) <= new Date(stayTo + 'T23:59:59')));
    // 归因提示（供复盘页直接展示结论）；标准入住时间 14:00（+08:00）
    const cleaningLate = cleaningTasks.some((t) => t.finishedAt && new Date(t.finishedAt) > new Date(`${t.date}T14:00:00+08:00`));
    const linenDelayed = deliveries.some((d) => d.status === 'delayed');
    const breakfastShort = preps.some((p) => p.status === 'shortage' || p.preparedPortions < p.requiredPortions);
    const equipmentFault = equip.some((e) => e.status !== 'normal');
    // 管家平均响应时长（客人消息 → 下一条管家回复）
    let respSum = 0; let respCnt = 0;
    for (let i = 0; i < messages.length; i++) {
      if (messages[i].direction !== 'guest') continue;
      const reply = messages.slice(i + 1).find((m) => m.direction === 'butler');
      if (reply) { respSum += (new Date(reply.sentAt).getTime() - new Date(messages[i].sentAt).getTime()) / 60000; respCnt += 1; }
    }
    return {
      review: { ...review, bookingCode: b.code, guestName: b.guestName, channel: (b.channel as any)?.name, room: (b.room as any)?.code },
      booking: b,
      issues,
      evidence: {
        breakfastPreps: preps,
        equipmentLogs: equip,
        cleaningTasks,
        linenDeliveries: deliveries,
        butlerMessages: messages,
        incidents: relatedIncidents,
      },
      findings: {
        cleaningLate, linenDelayed, breakfastShort, equipmentFault,
        avgButlerResponseMin: respCnt ? Math.round(respSum / respCnt) : null,
      },
      remediations: rems,
      remediation: rems[0] || null,
      amendments: amends,
    };
  }

  // 客人在平台修改差评（补救完成后持续观察）：记录修改历史并更新当前评分
  @Post(':id/amend')
  async amend(@Param('id') id: number, @Body() body: { rating: number; content?: string }) {
    const review = await this.reviews.findOne({ where: { id } });
    if (!review) throw new NotFoundException('评价不存在');
    if (!body.rating || body.rating < 1 || body.rating > 5) throw new BadRequestException('评分需为 1-5');
    return this.dataSource.transaction(async (em) => {
      await em.save(em.create(ReviewAmendment, {
        reviewId: review.id, oldRating: review.rating, newRating: body.rating,
        oldContent: review.content, newContent: body.content ?? review.content,
      }));
      review.rating = body.rating;
      if (body.content !== undefined) review.content = body.content;
      if (body.rating > 3) review.watching = false; // 评分改回 4 分以上，观察结束（渠道评分恢复）
      await em.save(review);
      return review;
    });
  }
}

// ================= 差评归因核实 =================
@Controller('review-issues')
export class ReviewIssuesController {
  constructor(@InjectRepository(ReviewIssue) private issues: Repository<ReviewIssue>) {}

  @Post(':id/verify')
  async verify(@Param('id') id: number, @Body() body: { status: string; note?: string }) {
    const it = await this.issues.findOne({ where: { id } });
    if (!it) throw new NotFoundException('归因不存在');
    if (!['confirmed', 'rejected'].includes(body.status)) throw new BadRequestException('状态需为 confirmed/rejected');
    it.status = body.status;
    it.evidenceNote = body.note || it.evidenceNote;
    return this.issues.save(it);
  }
}

// ================= 补救（退款/补偿券/电话道歉/不予补偿） =================
@Controller('remediations')
@Roles('owner', 'housekeeper')
export class RemediationsController {
  constructor(
    @InjectRepository(Remediation) private remediations: Repository<Remediation>,
    @InjectRepository(Review) private reviews: Repository<Review>,
    @InjectRepository(Incident) private incidents: Repository<Incident>,
    @InjectRepository(Compensation) private compensations: Repository<Compensation>,
    private dataSource: DataSource,
  ) {}

  @Get()
  list() {
    return this.remediations.find({ order: { id: 'DESC' } });
  }

  // 店主补救决策：refund 退款 | voucher 补偿券 | phone_apology 电话道歉 | none 不予补偿
  @Post('for-review/:reviewId')
  async remediate(@Param('reviewId') reviewId: number,
                  @Body() body: { action: string; amount?: number; note?: string },
                  @CurrentUser() user: any) {
    const review = await this.reviews.findOne({ where: { id: reviewId } });
    if (!review) throw new NotFoundException('评价不存在');
    if (!['refund', 'voucher', 'phone_apology', 'none'].includes(body.action)) {
      throw new BadRequestException('补救方式需为 refund/voucher/phone_apology/none');
    }
    const pending = await this.remediations.findOne({ where: { reviewId, status: 'pending' } });
    if (pending) throw new BadRequestException('存在待客人回应的补救，请先登记客人回应');
    const amount = ['refund', 'voucher'].includes(body.action) ? Number(body.amount || 0) : 0;
    if (['refund', 'voucher'].includes(body.action) && amount <= 0) {
      throw new BadRequestException('退款/补偿券需填写大于 0 的金额');
    }
    return this.dataSource.transaction(async (em) => {
      // 退款/补偿券 → 生成补偿记录，成本计入结算与该渠道真实获客成本
      let comp: Compensation = null;
      if (['refund', 'voucher'].includes(body.action)) {
        const voucherCode = body.action === 'voucher'
          ? 'VC' + Math.random().toString(36).slice(2, 8).toUpperCase()
          : null;
        comp = await em.save(em.create(Compensation, {
          reviewId: review.id, bookingId: review.bookingId, incidentId: null,
          type: body.action, amount: round2(amount), voucherCode,
          status: 'issued', reason: body.note || '差评补救',
        }));
      }
      const rem = await em.save(em.create(Remediation, {
        reviewId: review.id, bookingId: review.bookingId, action: body.action,
        amount: round2(amount), voucherCode: comp?.voucherCode || null,
        status: body.action === 'none' ? 'closed' : 'pending',
        note: body.note || '', createdBy: user?.name || user?.username || '',
        compensationId: comp?.id || null,
      }));
      if (body.action === 'none') {
        // 不予补偿：直接关闭差评事件，仍继续观察客人是否修改差评
        await em.update(Incident, { bookingId: review.bookingId, type: 'bad_review', status: 'open' }, {
          status: 'resolved', resolvedAt: new Date(),
          resolution: `店主决定不予补偿${body.note ? `：${body.note}` : ''}`,
        });
        review.watching = true;
        await em.save(review);
      }
      return rem;
    });
  }

  // 客人回应：接受 → 关闭差评事件并开始观察；拒绝 → 补偿作废，继续观察
  @Post(':id/respond')
  async respond(@Param('id') id: number, @Body() body: { accept: boolean; note?: string }) {
    const rem = await this.remediations.findOne({ where: { id } });
    if (!rem) throw new NotFoundException('补救记录不存在');
    if (rem.status !== 'pending') throw new BadRequestException('该补救已有客人回应');
    const review = await this.reviews.findOne({ where: { id: rem.reviewId } });
    return this.dataSource.transaction(async (em) => {
      rem.status = body.accept ? 'accepted' : 'rejected';
      rem.respondedAt = new Date();
      rem.guestNote = body.note || '';
      await em.save(rem);
      if (body.accept) {
        review.compensated = true;
        const label = { refund: `退款 ¥${rem.amount}`, voucher: `补偿券 ${rem.voucherCode} ¥${rem.amount}`, phone_apology: '电话道歉' }[rem.action] || rem.action;
        await em.update(Incident, { bookingId: rem.bookingId, type: 'bad_review', status: 'open' }, {
          status: 'resolved', resolvedAt: new Date(), resolution: `客人已接受补救（${label}）`,
        });
      } else if (rem.compensationId) {
        // 客人拒绝 → 补偿未实际发生，作废不计入成本
        await em.update(Compensation, rem.compensationId, { status: 'cancelled' });
      }
      review.watching = true; // 补救完成后持续观察客人是否修改差评
      await em.save(review);
      return rem;
    });
  }
}

// ================= 补偿 =================
@Controller('compensations')
export class CompensationsController {
  constructor(
    @InjectRepository(Compensation) private compensations: Repository<Compensation>,
    @InjectRepository(Review) private reviews: Repository<Review>,
    @InjectRepository(Incident) private incidents: Repository<Incident>,
    private dataSource: DataSource,
  ) {}

  @Get()
  list() {
    return this.compensations.find({ order: { id: 'DESC' } });
  }

  // 对差评发放补偿（现金/退款/补偿券），并联动关闭差评事件
  @Post('for-review/:reviewId')
  async compensate(@Param('reviewId') reviewId: number,
                   @Body() body: { type: string; amount: number; reason?: string }) {
    const review = await this.reviews.findOne({ where: { id: reviewId } });
    if (!review) throw new NotFoundException('评价不存在');
    if (!['cash', 'voucher', 'refund'].includes(body.type)) throw new BadRequestException('补偿类型不合法');
    if (!body.amount || body.amount <= 0) throw new BadRequestException('补偿金额需大于 0');
    return this.dataSource.transaction(async (em) => {
      const voucherCode = body.type === 'voucher'
        ? 'VC' + Math.random().toString(36).slice(2, 8).toUpperCase()
        : null;
      const comp = await em.save(em.create(Compensation, {
        reviewId: review.id, bookingId: review.bookingId, incidentId: null,
        type: body.type, amount: round2(body.amount), voucherCode,
        status: 'issued', reason: body.reason || '差评补偿',
      }));
      review.compensated = true;
      await em.save(review);
      await em.update(Incident, { bookingId: review.bookingId, type: 'bad_review', status: 'open' }, {
        status: 'resolved', resolvedAt: new Date(),
        resolution: `已补偿 ${body.type === 'voucher' ? `补偿券 ${voucherCode} ` : ''}¥${body.amount}`,
      });
      return comp;
    });
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

@Module({
  imports: [TypeOrmModule.forFeature([
    Incident, Booking, Room, MaintenanceTicket, Review, Compensation,
    ReviewIssue, Remediation, ReviewAmendment, BreakfastPrep, EquipmentLog,
    CleaningTask, LinenDelivery, ButlerMessage,
  ])],
  controllers: [IncidentsController, ReviewsController, ReviewIssuesController, RemediationsController, CompensationsController],
})
export class GuestModule {}
