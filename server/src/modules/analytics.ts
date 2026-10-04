import {
  BadRequestException, Body, Controller, Get, Module, Post, Query,
} from '@nestjs/common';
import { InjectRepository, TypeOrmModule } from '@nestjs/typeorm';
import { Between, Repository } from 'typeorm';
import {
  Booking, BreakfastPrep, ButlerMessage, Channel, CleaningTask, Compensation, DailyInventory,
  Incident, LinenDelivery, LinenItem, MaintenanceTicket, Remediation, Review,
  ReviewAmendment, Room, RoomType, User,
} from '../entities';
import { Roles } from '../common/auth';
import { addDays, diffDays, eachDay, overlapNights, round2, todayStr } from '../common/util';

const CLEANING_COST_PER_TASK = 35; // 单次保洁成本
const LINEN_WASH_COST = 6;         // 单套布草洗涤成本
const BREAKFAST_COST_PER_PORTION = 15; // 单份早餐成本

@Controller('analytics')
@Roles('owner', 'housekeeper')
export class AnalyticsController {
  constructor(
    @InjectRepository(Booking) private bookings: Repository<Booking>,
    @InjectRepository(Room) private rooms: Repository<Room>,
    @InjectRepository(RoomType) private types: Repository<RoomType>,
    @InjectRepository(Incident) private incidents: Repository<Incident>,
    @InjectRepository(Review) private reviews: Repository<Review>,
    @InjectRepository(Compensation) private compensations: Repository<Compensation>,
    @InjectRepository(CleaningTask) private cleaning: Repository<CleaningTask>,
    @InjectRepository(LinenItem) private linen: Repository<LinenItem>,
    @InjectRepository(LinenDelivery) private deliveries: Repository<LinenDelivery>,
    @InjectRepository(BreakfastPrep) private preps: Repository<BreakfastPrep>,
    @InjectRepository(DailyInventory) private inventory: Repository<DailyInventory>,
    @InjectRepository(MaintenanceTicket) private maintenance: Repository<MaintenanceTicket>,
    @InjectRepository(Channel) private channels: Repository<Channel>,
    @InjectRepository(User) private users: Repository<User>,
    @InjectRepository(Remediation) private remediations: Repository<Remediation>,
    @InjectRepository(ReviewAmendment) private amendments: Repository<ReviewAmendment>,
    @InjectRepository(ButlerMessage) private messages: Repository<ButlerMessage>,
  ) {}

  private async bookingsInRange(from: string, to: string) {
    const all = await this.bookings.find({ relations: ['channel', 'roomType', 'room'] });
    return all.filter((b) => b.status !== 'cancelled' && b.checkIn <= to && b.checkOut >= from);
  }

  // 经营看板
  @Get('dashboard')
  async dashboard(@Query('from') from?: string, @Query('to') to?: string) {
    const start = from || addDays(todayStr(), -7);
    const end = to || addDays(todayStr(), 7);
    const days = diffDays(start, end) + 1;
    const roomCount = await this.rooms.count();
    const bookings = await this.bookingsInRange(start, end);
    const soldNights = bookings.reduce((s, b) => s + overlapNights(b.checkIn, b.checkOut, start, addDays(end, 1)), 0);
    const roomNightsAvailable = roomCount * days;
    const revenue = bookings.reduce((s, b) => {
      const share = b.nights > 0 ? overlapNights(b.checkIn, b.checkOut, start, addDays(end, 1)) / b.nights : 0;
      return s + Number(b.totalAmount) * share;
    }, 0);
    const roomFeeRevenue = bookings.reduce((s, b) => {
      const share = b.nights > 0 ? overlapNights(b.checkIn, b.checkOut, start, addDays(end, 1)) / b.nights : 0;
      return s + Number(b.roomFee) * share;
    }, 0);
    const incidents = await this.incidents.find({ where: { occurredAt: Between(new Date(start), new Date(end + 'T23:59:59')) } });
    const byType: Record<string, number> = {};
    for (const i of incidents) byType[i.type] = (byType[i.type] || 0) + 1;
    const reviews = await this.reviews.find();
    const comps = await this.compensations.find();
    const compTotal = comps.filter((c) => c.status !== 'cancelled').reduce((s, c) => s + Number(c.amount), 0);
    const reviewByCat: Record<string, number> = {};
    for (const r of reviews) reviewByCat[r.category] = (reviewByCat[r.category] || 0) + 1;
    // 每日入住率曲线
    const daily = eachDay(start, end).map((d) => {
      const sold = bookings.reduce((s, b) => s + (b.checkIn <= d && b.checkOut > d ? 1 : 0), 0);
      return { date: d, sold, occupancy: roomCount ? round2((sold / roomCount) * 100) : 0 };
    });
    // 渠道收入
    const byChannel: Record<string, number> = {};
    for (const b of bookings) {
      const name = (b.channel as any)?.name || '未知';
      byChannel[name] = round2((byChannel[name] || 0) + Number(b.totalAmount));
    }
    return {
      range: { from: start, to: end },
      kpi: {
        occupancy: roomNightsAvailable ? round2((soldNights / roomNightsAvailable) * 100) : 0,
        soldNights, roomNightsAvailable,
        revenue: round2(revenue),
        adr: soldNights ? round2(roomFeeRevenue / soldNights) : 0,
        revpar: roomNightsAvailable ? round2(roomFeeRevenue / roomNightsAvailable) : 0,
        compensationCost: round2(compTotal),
        reviewCount: reviews.length,
        badReviewCount: reviews.filter((r) => r.rating <= 3).length,
        avgRating: reviews.length ? round2(reviews.reduce((s, r) => s + r.rating, 0) / reviews.length) : 0,
      },
      incidentsByType: Object.entries(byType).map(([type, count]) => ({ type, count })),
      reviewByCategory: Object.entries(reviewByCat).map(([category, count]) => ({ category, count })),
      daily,
      revenueByChannel: Object.entries(byChannel).map(([name, value]) => ({ name, value })),
    };
  }

  // 旺季复盘：分渠道/房型利润 + 服务环节成本 + 问题归类
  @Get('profit')
  async profit(@Query('from') from?: string, @Query('to') to?: string) {
    const start = from || addDays(todayStr(), -14);
    const end = to || todayStr();
    const bookings = (await this.bookingsInRange(start, end))
      .filter((b) => b.checkIn >= start && b.checkIn <= end);
    const comps = await this.compensations.find();
    const compOf = (id: number) => comps.filter((c) => c.bookingId === id && c.status !== 'cancelled')
      .reduce((s, c) => s + Number(c.amount), 0);

    const group = (keyOf: (b: Booking) => string) => {
      const map = new Map<string, any>();
      for (const b of bookings) {
        const k = keyOf(b);
        const cur = map.get(k) || { name: k, bookings: 0, gross: 0, commission: 0, compensation: 0, depositKept: 0, net: 0 };
        const commission = Number(b.roomFee) * Number((b.channel as any)?.commissionRate || 0);
        const comp = compOf(b.id);
        cur.bookings += 1;
        cur.gross = round2(cur.gross + Number(b.totalAmount));
        cur.commission = round2(cur.commission + commission);
        cur.compensation = round2(cur.compensation + comp);
        cur.depositKept = round2(cur.depositKept + Number(b.depositDeducted));
        cur.net = round2(cur.net + Number(b.totalAmount) - commission - comp + Number(b.depositDeducted));
        map.set(k, cur);
      }
      return [...map.values()].map((r) => ({ ...r, margin: r.gross ? round2((r.net / r.gross) * 100) : 0 }));
    };

    // 服务环节收入与成本
    const seg = bookings.reduce((acc, b) => ({
      roomFee: round2(acc.roomFee + Number(b.roomFee)),
      extraBed: round2(acc.extraBed + Number(b.extraBedFee)),
      breakfast: round2(acc.breakfast + Number(b.breakfastFee)),
      petFee: round2(acc.petFee + Number(b.petFee)),
    }), { roomFee: 0, extraBed: 0, breakfast: 0, petFee: 0 });
    const cleaningTasks = await this.cleaning.find({ where: { date: Between(start, end) } });
    const linenUsed = cleaningTasks.reduce((s, t) => s + t.linenUsed, 0);
    const preps = await this.preps.find({ where: { date: Between(start, end) } });
    const breakfastPortions = preps.reduce((s, p) => s + p.preparedPortions, 0);
    const maintenanceCost = (await this.maintenance.find())
      .reduce((s, m) => s + Number(m.cost), 0);
    const totalComp = comps.filter((c) => c.status !== 'cancelled').reduce((s, c) => s + Number(c.amount), 0);
    const totalCommission = bookings.reduce((s, b) => s + Number(b.roomFee) * Number((b.channel as any)?.commissionRate || 0), 0);
    const costs = {
      cleaning: round2(cleaningTasks.length * CLEANING_COST_PER_TASK),
      linen: round2(linenUsed * LINEN_WASH_COST),
      breakfast: round2(breakfastPortions * BREAKFAST_COST_PER_PORTION),
      maintenance: round2(maintenanceCost),
      compensation: round2(totalComp),
      commission: round2(totalCommission),
    };
    const grossTotal = round2(seg.roomFee + seg.extraBed + seg.breakfast + seg.petFee);
    const costTotal = round2(Object.values(costs).reduce((s, v) => s + v, 0));

    // 问题归类：价格策略 / 履约能力 / 个别客诉
    const incidents = await this.incidents.find();
    const fulfillmentTypes = ['linen_delay', 'breakfast_shortage', 'oversell', 'ac_failure', 'late_checkout'];
    const fulfillmentCount = incidents.filter((i) => fulfillmentTypes.includes(i.type)).length;
    const reviews = await this.reviews.find();
    const badReviews = reviews.filter((r) => r.rating <= 3);
    const classification: any[] = [];
    const byChannelList = group((b) => (b.channel as any)?.name || '未知');
    // 价格策略问题：渠道间净利率差距大（高佣金/低价渠道侵蚀利润）
    const margins = byChannelList.filter((c) => c.gross > 0).map((c) => c.margin);
    const worst = byChannelList.filter((c) => c.gross > 0)
      .sort((a, b) => a.margin - b.margin)[0];
    if (margins.length >= 2 && Math.max(...margins) - Math.min(...margins) >= 5 && worst) {
      classification.push({
        type: '价格策略问题',
        evidence: `渠道「${worst.name}」净利率 ${worst.margin}%（佣金 ¥${worst.commission}），与最优渠道相差 ${round2(Math.max(...margins) - Math.min(...margins))} 个百分点`,
        suggestion: '下调高佣金渠道配额或上调该渠道挂牌价；提升官网/电话等直销占比',
      });
    }
    if (fulfillmentCount > 0) {
      const counts: Record<string, number> = {};
      for (const i of incidents.filter((x) => fulfillmentTypes.includes(x.type))) counts[i.type] = (counts[i.type] || 0) + 1;
      classification.push({
        type: '履约能力问题',
        evidence: `旺季共 ${fulfillmentCount} 起履约事件：${Object.entries(counts).map(([k, v]) => `${k}×${v}`).join('、')}`,
        suggestion: '增加保洁排班与布草安全库存，早餐按上限备餐，超卖房型下调可售房量',
      });
    }
    const complaintCats = [...new Set(badReviews.map((r) => r.category))];
    if (badReviews.length) {
      classification.push({
        type: '个别客诉',
        evidence: `${badReviews.length} 条差评，集中在 ${complaintCats.join('、')} 类，补偿支出 ¥${round2(totalComp)}`,
        suggestion: '对硬件类差评安排检修复核；服务类差评纳入管家培训；及时补偿止损',
      });
    }

    return {
      range: { from: start, to: end },
      byChannel: byChannelList,
      byRoomType: group((b) => (b.roomType as any)?.name || '未知'),
      serviceSegments: { revenue: seg, costs, grossTotal, costTotal, net: round2(grossTotal - costTotal) },
      classification,
    };
  }

  // 下一轮节假日可售房量建议：根据超卖、布草延迟、早餐投诉、补偿成本自动调整
  @Get('adjustment')
  async adjustment() {
    const types = await this.types.find({ order: { id: 'ASC' } });
    const rooms = await this.rooms.find();
    const incidents = await this.incidents.find();
    const bookings = await this.bookings.find({ relations: ['channel'] });
    const comps = await this.compensations.find();
    const deliveries = await this.deliveries.find();
    const linenDelayCount = deliveries.filter((d) => d.status === 'delayed').length;
    const linenDelayRate = deliveries.length ? linenDelayCount / deliveries.length : 0;
    const breakfastShortages = incidents.filter((i) => i.type === 'breakfast_shortage').length;

    const rows = types.map((t) => {
      const total = rooms.filter((r) => r.roomTypeId === t.id).length;
      const typeBookings = bookings.filter((b) => b.roomTypeId === t.id);
      const oversellCount = incidents.filter((i) => i.type === 'oversell'
        && typeBookings.some((b) => b.id === i.bookingId)).length;
      const gross = typeBookings.reduce((s, b) => s + Number(b.totalAmount), 0);
      const compCost = comps.filter((c) => typeBookings.some((b) => b.id === c.bookingId))
        .reduce((s, c) => s + Number(c.amount), 0);
      const compRatio = gross > 0 ? compCost / gross : 0;
      const reasons: string[] = [];
      let reduction = 0;
      if (oversellCount > 0) { reduction += Math.min(2, oversellCount); reasons.push(`超卖 ${oversellCount} 起，预留缓冲房`); }
      if (linenDelayRate > 0.2) { reduction += 1; reasons.push(`布草延迟率 ${round2(linenDelayRate * 100)}%，保洁周转受限`); }
      if (breakfastShortages >= 1) { reduction += 1; reasons.push(`早餐供应不足 ${breakfastShortages} 天，厨房接待能力受限`); }
      if (compRatio > 0.05) { reduction += 1; reasons.push(`补偿成本占收入 ${round2(compRatio * 100)}%，履约风险高`); }
      const adjusted = Math.max(Math.ceil(total / 2), total - reduction);
      return {
        typeId: t.id, typeName: t.name, total, adjustedSellable: adjusted,
        reduction: total - adjusted, oversellCount, breakfastShortages,
        linenDelayRate: round2(linenDelayRate * 100), compCost: round2(compCost),
        compRatio: round2(compRatio * 100), reasons,
      };
    });
    return { rows };
  }

  // 渠道评分恢复：补救是否被客人接受 + 客人是否修改差评，共同决定渠道评分恢复度
  @Get('channel-recovery')
  async channelRecovery() {
    const channels = await this.channels.find({ order: { id: 'ASC' } });
    const reviews = await this.reviews.find({ relations: ['booking'] });
    const rems = await this.remediations.find();
    const amends = await this.amendments.find({ order: { id: 'ASC' } });
    const rows = channels.map((ch) => {
      const chReviews = reviews.filter((r) => (r.booking as any)?.channelId === ch.id);
      const originalOf = (r: Review) => {
        const first = amends.filter((a) => a.reviewId === r.id)[0];
        return first ? first.oldRating : r.rating;
      };
      const badOriginal = chReviews.filter((r) => originalOf(r) <= 3);
      const chRems = rems.filter((m) => badOriginal.some((r) => r.id === m.reviewId));
      const accepted = chRems.filter((m) => m.status === 'accepted').length;
      const rejected = chRems.filter((m) => m.status === 'rejected').length;
      const responded = accepted + rejected;
      const recovered = badOriginal.filter((r) => r.rating > 3).length; // 客人修改后回到 4 分以上
      const amended = badOriginal.filter((r) => amends.some((a) => a.reviewId === r.id)).length;
      return {
        channelId: ch.id, channel: ch.name,
        reviewCount: chReviews.length,
        badReviewCount: badOriginal.length,
        remediated: new Set(chRems.map((m) => m.reviewId)).size,
        accepted, rejected,
        noneCount: chRems.filter((m) => m.action === 'none').length,
        acceptanceRate: responded ? round2((accepted / responded) * 100) : null, // 补救接受率（排班参考）
        amendedCount: amended,
        recoveredCount: recovered,
        recoveryRate: badOriginal.length ? round2((recovered / badOriginal.length) * 100) : 0, // 差评恢复率
        avgOriginalRating: chReviews.length ? round2(chReviews.reduce((s, r) => s + originalOf(r), 0) / chReviews.length) : null,
        avgCurrentRating: chReviews.length ? round2(chReviews.reduce((s, r) => s + r.rating, 0) / chReviews.length) : null,
        watching: chReviews.filter((r) => r.watching).length, // 仍在观察中的差评
      };
    });
    return { rows };
  }

  // 渠道真实获客成本：渠道佣金 + 差评补偿成本，摊到每单/每间夜
  @Get('channel-cac')
  async channelCac(@Query('from') from?: string, @Query('to') to?: string) {
    const start = from || addDays(todayStr(), -14);
    const end = to || todayStr();
    const channels = await this.channels.find({ order: { id: 'ASC' } });
    const bookings = (await this.bookingsInRange(start, end))
      .filter((b) => b.checkIn >= start && b.checkIn <= end);
    const comps = await this.compensations.find();
    const rows = channels.map((ch) => {
      const chBookings = bookings.filter((b) => b.channelId === ch.id);
      const commission = chBookings.reduce((s, b) => s + Number(b.roomFee) * Number((b.channel as any)?.commissionRate || 0), 0);
      const compensation = comps
        .filter((c) => c.status !== 'cancelled' && chBookings.some((b) => b.id === c.bookingId))
        .reduce((s, c) => s + Number(c.amount), 0);
      const nights = chBookings.reduce((s, b) => s + b.nights, 0);
      const gross = chBookings.reduce((s, b) => s + Number(b.totalAmount), 0);
      const acquisitionCost = round2(commission + compensation); // 真实获客成本 = 佣金 + 补偿成本
      return {
        channelId: ch.id, channel: ch.name,
        bookings: chBookings.length, nights,
        gross: round2(gross),
        commission: round2(commission),
        compensation: round2(compensation),
        acquisitionCost,
        cacPerBooking: chBookings.length ? round2(acquisitionCost / chBookings.length) : 0,
        cacPerNight: nights ? round2(acquisitionCost / nights) : 0,
        costRatio: gross > 0 ? round2((acquisitionCost / gross) * 100) : 0, // 获客成本占收入比
      };
    });
    const totalCost = rows.reduce((s, r) => s + r.acquisitionCost, 0);
    const totalBookings = rows.reduce((s, r) => s + r.bookings, 0);
    return {
      range: { from: start, to: end }, rows,
      totals: {
        acquisitionCost: round2(totalCost), bookings: totalBookings,
        cacPerBooking: totalBookings ? round2(totalCost / totalBookings) : 0,
      },
    };
  }

  // 下一轮旺季排班建议：参考本次旺季保洁峰值、早餐缺口、管家响应与补救接受率
  @Get('staffing-plan')
  async staffingPlan(@Query('from') from?: string, @Query('to') to?: string) {
    const start = from || '2026-12-31';
    const end = to || '2027-01-02';
    const days = diffDays(start, end) + 1;
    const users = await this.users.find();
    const tasks = await this.cleaning.find();
    const preps = await this.preps.find();
    const deliveries = await this.deliveries.find();
    const messages = await this.messages.find();
    const rems = await this.remediations.find();
    const reviews = await this.reviews.find();
    const amends = await this.amendments.find();

    // 保洁：峰值日任务量 × 平均时长 / 班次有效工时(6h)
    const byDate: Record<string, CleaningTask[]> = {};
    for (const t of tasks) byDate[t.date] = [...(byDate[t.date] || []), t];
    const peakDate = Object.entries(byDate).sort((a, b) => b[1].length - a[1].length)[0];
    const durationOf = (d: string) => (d === 'heavy' ? 70 : d === 'light' ? 30 : 45);
    const peakTasks = peakDate ? peakDate[1].length : 0;
    const avgMin = tasks.length ? tasks.reduce((s, t) => s + durationOf(t.dirtiness), 0) / tasks.length : 45;
    const linenDelayRate = deliveries.length ? deliveries.filter((d) => d.status === 'delayed').length / deliveries.length : 0;
    const cleanersNow = users.filter((u) => u.role === 'cleaner').length;
    let cleanersNeed = Math.max(cleanersNow, Math.ceil((peakTasks * avgMin) / 360));
    const cleanerReasons = [`旺季峰值日 ${peakDate?.[0] || '-'} 共 ${peakTasks} 单保洁，单均 ${Math.round(avgMin)} 分钟`];
    if (linenDelayRate > 0.2) {
      cleanersNeed += 1;
      cleanerReasons.push(`布草延迟率 ${round2(linenDelayRate * 100)}%，保洁周转需冗余人力`);
    }

    // 管家：响应时长 + 补救接受率（接受率低说明沟通与补救方案需加强）
    let respSum = 0; let respCnt = 0;
    const sorted = [...messages].sort((a, b) => +new Date(a.sentAt) - +new Date(b.sentAt));
    for (let i = 0; i < sorted.length; i++) {
      if (sorted[i].direction !== 'guest') continue;
      const reply = sorted.slice(i + 1).find((m) => m.direction === 'butler' && m.bookingId === sorted[i].bookingId);
      if (reply) { respSum += (+new Date(reply.sentAt) - +new Date(sorted[i].sentAt)) / 60000; respCnt += 1; }
    }
    const avgRespMin = respCnt ? Math.round(respSum / respCnt) : 0;
    const accepted = rems.filter((m) => m.status === 'accepted').length;
    const rejected = rems.filter((m) => m.status === 'rejected').length;
    const acceptanceRate = accepted + rejected ? accepted / (accepted + rejected) : 1;
    const stewardsNow = users.filter((u) => u.role === 'housekeeper').length;
    let stewardsNeed = stewardsNow;
    const stewardReasons = [`管家平均响应 ${avgRespMin} 分钟，补救接受率 ${round2(acceptanceRate * 100)}%`];
    if (avgRespMin > 45) { stewardsNeed += 1; stewardReasons.push('响应超过 45 分钟，入住高峰需加 1 名管家'); }
    if (acceptanceRate < 0.6) { stewardsNeed += 1; stewardReasons.push('补救接受率偏低，需专人跟进安抚与回访'); }

    // 厨房：早餐不足天数 → 备餐上浮 + 帮厨
    const shortageDays = preps.filter((p) => p.status === 'shortage' || p.preparedPortions < p.requiredPortions).length;
    const peakRequired = preps.length ? Math.max(...preps.map((p) => p.requiredPortions)) : 0;
    const kitchenNow = users.filter((u) => u.role === 'kitchen').length;
    let kitchenNeed = kitchenNow;
    const kitchenReasons = [`峰值日早餐需求 ${peakRequired} 份，供应不足 ${shortageDays} 天`];
    if (shortageDays > 0) { kitchenNeed += 1; kitchenReasons.push('建议按峰值上浮 15% 备餐并加 1 名帮厨'); }

    // 补救被接受且客人改回高分 → 差评恢复，可少派安抚人力；反之加强
    const recovered = reviews.filter((r) => r.rating > 3 && amends.some((a) => a.reviewId === r.id && a.oldRating <= 3)).length;
    return {
      range: { from: start, to: end, days },
      basis: {
        peakTasks, avgCleanMin: Math.round(avgMin), linenDelayRate: round2(linenDelayRate * 100),
        avgButlerResponseMin: avgRespMin, remediationAcceptanceRate: round2(acceptanceRate * 100),
        breakfastShortageDays: shortageDays, recoveredBadReviews: recovered,
      },
      rows: [
        { role: 'cleaner', roleName: '保洁', current: cleanersNow, suggested: cleanersNeed, reasons: cleanerReasons },
        { role: 'housekeeper', roleName: '管家', current: stewardsNow, suggested: stewardsNeed, reasons: stewardReasons },
        { role: 'kitchen', roleName: '厨房', current: kitchenNow, suggested: kitchenNeed, reasons: kitchenReasons },
      ],
    };
  }

  // 应用调整：为下一轮节假日生成调整后的可售库存
  @Post('apply-adjustment')
  async applyAdjustment(@Body() body: { from: string; to: string }) {
    if (!body.from || !body.to) throw new BadRequestException('日期必填');
    const { rows } = await this.adjustment();
    const sellableByType = Object.fromEntries(rows.map((r) => [r.typeId, r.adjustedSellable]));
    const types = await this.types.find();
    const rooms = await this.rooms.find();
    for (const t of types) {
      const total = rooms.filter((r) => r.roomTypeId === t.id).length;
      for (const d of eachDay(body.from, addDays(body.to, 1))) {
        let inv = await this.inventory.findOne({ where: { roomTypeId: t.id, date: d } });
        if (!inv) inv = this.inventory.create({ roomTypeId: t.id, date: d, booked: 0 });
        inv.total = total;
        inv.sellable = Math.min(sellableByType[t.id] ?? total, total);
        await this.inventory.save(inv);
      }
    }
    return { ok: true, applied: sellableByType, range: { from: body.from, to: body.to } };
  }
}

@Module({
  imports: [TypeOrmModule.forFeature([
    Booking, Room, RoomType, Incident, Review, Compensation, CleaningTask,
    LinenItem, LinenDelivery, BreakfastPrep, DailyInventory, MaintenanceTicket,
    Channel, User, Remediation, ReviewAmendment, ButlerMessage,
  ])],
  controllers: [AnalyticsController],
})
export class AnalyticsModule {}
