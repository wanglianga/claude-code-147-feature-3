import {
  BadRequestException, Body, Controller, Get, Module, Post, Query,
} from '@nestjs/common';
import { InjectRepository, TypeOrmModule } from '@nestjs/typeorm';
import { Between, Repository } from 'typeorm';
import {
  Booking, BreakfastPrep, Compensation, DailyInventory, EquipmentLog, Incident,
  LinenDelivery, LinenItem, MaintenanceTicket, Remediation, Review, Room, RoomType, CleaningTask,
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
    @InjectRepository(Remediation) private remediations: Repository<Remediation>,
    @InjectRepository(EquipmentLog) private equipLogs: Repository<EquipmentLog>,
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
    // 补救与评分恢复
    const rems = await this.remediations.find();
    const activeRems = rems.filter((m) => ['accepted', 'rejected', 'proposed'].includes(m.status));
    const remClosed = rems.filter((m) => m.status === 'closed').length;
    const remAccepted = activeRems.filter((m) => m.status === 'accepted');
    const remRejected = activeRems.filter((m) => m.status === 'rejected');
    const remProposed = activeRems.filter((m) => m.status === 'proposed');
    const acceptedRemIds = new Set(remAccepted.map((m) => m.id));
    // 真实补偿成本：旧链路补偿 + 客人已接受补救产生的补偿
    const compTotal = comps.filter((c) => c.status !== 'cancelled'
      && (c.remediationId === null || acceptedRemIds.has(c.remediationId)))
      .reduce((s, c) => s + Number(c.amount), 0);
    const reviewByCat: Record<string, number> = {};
    for (const r of reviews) reviewByCat[r.category] = (reviewByCat[r.category] || 0) + 1;
    const revisedReviews = reviews.filter((r) => r.monitorStatus === 'revised' && r.originalRating !== null);
    const ratingRecovered = revisedReviews.reduce((s, r) => s + (r.rating - (r.originalRating || r.rating)), 0);
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
        badReviewCount: reviews.filter((r) => r.rating <= 3 || (r.originalRating !== null && r.originalRating <= 3)).length,
        avgRating: reviews.length ? round2(reviews.reduce((s, r) => s + r.rating, 0) / reviews.length) : 0,
        remediationCount: activeRems.length,
        remediationClosed: remClosed,
        remediationAccepted: remAccepted.length,
        remediationRejected: remRejected.length,
        remediationPending: remProposed.length,
        remediationAcceptRate: activeRems.filter((m) => ['accepted', 'rejected'].includes(m.status)).length
          ? round2((remAccepted.length / activeRems.filter((m) => ['accepted', 'rejected'].includes(m.status)).length) * 100)
          : 0,
        revisedCount: revisedReviews.length,
        monitoringCount: reviews.filter((r) => r.monitorStatus === 'observing').length,
        unchangedCount: reviews.filter((r) => r.monitorStatus === 'unchanged').length,
        ratingRecovered: round2(ratingRecovered),
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
    const rems = await this.remediations.find();
    const acceptedRemIds = new Set(rems.filter((m) => m.status === 'accepted').map((m) => m.id));
    // 真实补偿：旧链路补偿 + 客人已接受补救产生的补偿（被拒绝/待回应不确认为成本）
    const realComp = (c: any) => c.status !== 'cancelled'
      && (c.remediationId === null || acceptedRemIds.has(c.remediationId));
    const compOf = (id: number) => comps.filter((c) => c.bookingId === id && realComp(c))
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
    const totalComp = comps.filter(realComp).reduce((s, c) => s + Number(c.amount), 0);
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

  // 渠道真实获客成本：佣金 + 差评补偿成本（仅计入已被客人接受的补救；被拒绝的补偿未真正付出）
  // 同时给出各渠道评分恢复情况，作为渠道权重参考
  @Get('channel-cac')
  async channelCac(@Query('from') from?: string, @Query('to') to?: string) {
    const start = from || addDays(todayStr(), -14);
    const end = to || todayStr();
    const bookings = (await this.bookingsInRange(start, end))
      .filter((b) => b.checkIn >= start && b.checkIn <= end);
    const comps = await this.compensations.find();
    const rems = await this.remediations.find();
    const reviews = await this.reviews.find({ relations: ['booking'] });

    const rows = [...new Map(bookings.map((b) => [b.channelId, (b.channel as any)?.name || '未知'])).entries()]
      .map(([channelId, name]) => {
        const cb = bookings.filter((b) => b.channelId === channelId);
        const bookingIds = new Set(cb.map((b) => b.id));
        const commission = round2(cb.reduce((s, b) => s + Number(b.roomFee) * Number((b.channel as any)?.commissionRate || 0), 0));
        // 旧链路补偿（无补救单）+ 已接受补救产生的补偿；拒绝/待回应不确认为真实成本
        const acceptedRemIds = new Set(rems.filter((m) => m.status === 'accepted').map((m) => m.id));
        const channelComps = comps.filter((c) => bookingIds.has(c.bookingId) && c.status !== 'cancelled'
          && (c.remediationId === null || acceptedRemIds.has(c.remediationId)));
        const compensation = round2(channelComps.reduce((s, c) => s + Number(c.amount), 0));
        const channelRems = rems.filter((m) => m.channelId === channelId
          && ['accepted', 'rejected', 'proposed'].includes(m.status));
        const accepted = channelRems.filter((m) => m.status === 'accepted').length;
        const rejected = channelRems.filter((m) => m.status === 'rejected').length;
        const pending = channelRems.filter((m) => m.status === 'proposed').length;
        // 渠道下差评的评分恢复
        const channelBad = reviews.filter((r) => {
          const orig = r.originalRating ?? r.rating;
          return orig <= 3 && bookingIds.has(r.bookingId);
        });
        const revised = channelBad.filter((r) => r.monitorStatus === 'revised');
        const observing = channelBad.filter((r) => r.monitorStatus === 'observing');
        const unchanged = channelBad.filter((r) => r.monitorStatus === 'unchanged');
        const avgOriginal = channelBad.length
          ? round2(channelBad.reduce((s, r) => s + (r.originalRating ?? r.rating), 0) / channelBad.length) : 0;
        const avgNow = channelBad.length
          ? round2(channelBad.reduce((s, r) => s + r.rating, 0) / channelBad.length) : 0;
        const respondTotal = accepted + rejected;
        return {
          channelId, name,
          bookings: cb.length,
          roomNights: cb.reduce((s, b) => s + b.nights, 0),
          commission, compensation,
          acquisitionCost: round2(commission + compensation),
          cacPerBooking: cb.length ? round2((commission + compensation) / cb.length) : 0,
          remediation: { total: channelRems.length, accepted, rejected, pending,
            acceptRate: respondTotal ? round2((accepted / respondTotal) * 100) : 0 },
          ratingRecovery: {
            badCount: channelBad.length, revised: revised.length,
            observing: observing.length, unchanged: unchanged.length,
            avgOriginal, avgNow, recovered: round2(avgNow - avgOriginal),
          },
        };
      });
    const totals = rows.reduce((acc, r) => ({
      commission: round2(acc.commission + r.commission),
      compensation: round2(acc.compensation + r.compensation),
      acquisitionCost: round2(acc.acquisitionCost + r.acquisitionCost),
      bookings: acc.bookings + r.bookings,
    }), { commission: 0, compensation: 0, acquisitionCost: 0, bookings: 0 });
    return { range: { from: start, to: end }, rows, totals };
  }

  // 下次旺季排班建议：参考本次每日在住/退房压力、早餐不足、除湿异常、布草延迟，
  // 以及差评补救是否被客人接受（被拒/待回应 → 当日加排缓冲；接受且改评 → 恢复正常排班）
  @Get('staffing-plan')
  async staffingPlan(@Query('from') from?: string, @Query('to') to?: string,
                     @Query('baseFrom') baseFrom = '2026-10-01', @Query('baseTo') baseTo = '2026-10-08') {
    const planFrom = from || '2026-12-31';
    const planTo = to || '2027-01-07';
    const baseDays = eachDay(baseFrom, addDays(baseTo, 1));
    const planDays = eachDay(planFrom, addDays(planTo, 1));
    const [bookings, preps, equipLogs, cleaningTasks, deliveries, rems, reviews] = await Promise.all([
      this.bookings.find({ relations: ['channel'] }),
      this.preps.find(),
      this.equipLogs.find(),
      this.cleaning.find({ relations: ['assignee'] }),
      this.deliveries.find(),
      this.remediations.find(),
      this.reviews.find(),
    ]);
    const acceptedRemBookingIds = new Set(rems.filter((m) => m.status === 'accepted').map((m) => m.bookingId));
    // 风险未化解：补救被拒/待回应 且 从未被接受（拒绝后又接受视为已化解）
    const riskRemBookingIds = new Set(rems
      .filter((m) => (m.status === 'rejected' || m.status === 'proposed') && !acceptedRemBookingIds.has(m.bookingId))
      .map((m) => m.bookingId));
    const revisedBookingIds = new Set(reviews.filter((r) => r.monitorStatus === 'revised').map((r) => r.bookingId));

    const rows = planDays.map((d, idx) => {
      const base = baseDays[Math.min(idx, baseDays.length - 1)];
      const staying = bookings.filter((b) => b.status !== 'cancelled' && b.checkIn < base && b.checkOut >= base);
      const checkouts = bookings.filter((b) => b.status !== 'cancelled' && b.checkOut === base);
      const breakfastRequired = staying.reduce((s, b) => s + b.breakfastCount, 0);
      const shortage = preps.find((p) => p.date === base && p.status === 'shortage');
      const dampAbnormal = equipLogs.filter((l) => l.date === base && l.status === 'abnormal').length;
      const linenDelayed = deliveries.filter((dl) => dl.status === 'delayed'
        && new Date(dl.expectedAt).toISOString().slice(0, 10) === base).length;
      const dayTasks = cleaningTasks.filter((t) => t.date === base);
      const heavyDirty = dayTasks.filter((t) => t.dirtiness === 'heavy').length;
      // 当日离店客人中：补救被拒/待回应且未改评 → 风险未化解，需加排
      const riskGuests = checkouts.filter((b) => riskRemBookingIds.has(b.id) && !revisedBookingIds.has(b.id));
      const recoveredGuests = checkouts.filter((b) => acceptedRemBookingIds.has(b.id) && revisedBookingIds.has(b.id));

      const warnings: string[] = [];
      // 每个保洁员旺季约承担 6 个常规退房打扫（重污按 1.5 计）
      const workload = checkouts.length + heavyDirty * 0.5 + (linenDelayed ? 0.5 : 0);
      let cleaners = Math.max(1, Math.ceil(workload / 6));
      if (riskGuests.length) { cleaners += 1; warnings.push(`有 ${riskGuests.length} 位客人补救未被接受/未改评，加排 1 名保洁并优先验收其房间`); }
      if (linenDelayed) warnings.push('基准日发生布草延迟，提前 2 小时催送并备安全库存');
      let kitchenPortions = breakfastRequired + 4; // 按上限 +4 份缓冲
      let kitchenExtra = 0;
      if (shortage) {
        kitchenExtra = 1; kitchenPortions += 4;
        warnings.push(`基准日早餐缺口 ${shortage.requiredPortions - shortage.preparedPortions} 份，加排 1 名厨房帮工并按上限备餐`);
      }
      const dehumidifierChecks = dampAbnormal > 0 ? 3 : (staying.length >= 8 ? 2 : 1);
      if (dampAbnormal) warnings.push(`基准日除湿设备异常 ${dampAbnormal} 次，入住前巡检+雨后加巡`);

      return {
        date: d, basedOn: base,
        staying: staying.length, checkouts: checkouts.length,
        breakfastRequired, heavyDirty,
        plan: {
          cleaners,
          kitchenStaff: 1 + kitchenExtra,
          kitchenPortions,
          dehumidifierChecks,
          linenBuffer: linenDelayed ? 10 : 5,
        },
        riskGuestIds: riskGuests.map((b) => b.code),
        recoveredGuestIds: recoveredGuests.map((b) => b.code),
        warnings,
      };
    });

    // 渠道维度排班提示：补救接受率低的渠道订单集中入住日，安排管家专人跟进
    const channelRisk = [...new Set(rems.filter((m) => ['accepted', 'rejected', 'proposed'].includes(m.status)).map((m) => m.channelId))].map((cid) => {
      const mr = rems.filter((m) => m.channelId === cid && ['accepted', 'rejected', 'proposed'].includes(m.status));
      const acc = mr.filter((m) => m.status === 'accepted').length;
      const rej = mr.filter((m) => m.status !== 'accepted').length;
      return { channelId: cid, total: mr.length, accepted: acc, rejected: rej,
        acceptRate: mr.length ? round2((acc / mr.length) * 100) : 0 };
    }).filter((c) => c.total > 0);

    return {
      range: { from: planFrom, to: planTo },
      baseRange: { from: baseFrom, to: baseTo },
      rows,
      channelRisk,
      rules: [
        '常规：每名保洁承担约 6 间退房打扫，重污房按 1.5 间计',
        '基准日早餐不足：加排 1 名厨房帮工，备餐量按需求 +8 份',
        '基准日除湿异常：入住前巡检 + 雨后加巡（每日 3 次）',
        '客人未接受补救或未改评：离店日加排 1 名保洁、管家优先验收并当面回访',
        '补救被接受且客人已改评：按常规排班，不额外占用旺季人力',
      ],
    };
  }

  // 下一轮节假日可售房量建议：根据超卖、布草延迟、早餐投诉、补偿成本、补救接受情况自动调整
  @Get('adjustment')
  async adjustment() {
    const types = await this.types.find({ order: { id: 'ASC' } });
    const rooms = await this.rooms.find();
    const incidents = await this.incidents.find();
    const bookings = await this.bookings.find({ relations: ['channel'] });
    const comps = await this.compensations.find();
    const rems = await this.remediations.find();
    const reviews = await this.reviews.find();
    const deliveries = await this.deliveries.find();
    const linenDelayCount = deliveries.filter((d) => d.status === 'delayed').length;
    const linenDelayRate = deliveries.length ? linenDelayCount / deliveries.length : 0;
    const breakfastShortages = incidents.filter((i) => i.type === 'breakfast_shortage').length;
    // 已被客人接受的补救才确认为真实补偿成本；未接受的不扣减收入但视为履约风险
    const acceptedRemIds = new Set(rems.filter((m) => m.status === 'accepted').map((m) => m.id));
    const acceptedCost = comps.filter((c) => c.status !== 'cancelled'
      && (c.remediationId === null || acceptedRemIds.has(c.remediationId)))
      .reduce((s, c) => s + Number(c.amount), 0);

    const rows = types.map((t) => {
      const total = rooms.filter((r) => r.roomTypeId === t.id).length;
      const typeBookings = bookings.filter((b) => b.roomTypeId === t.id);
      const typeBookingIds = new Set(typeBookings.map((b) => b.id));
      const oversellCount = incidents.filter((i) => i.type === 'oversell'
        && typeBookings.some((b) => b.id === i.bookingId)).length;
      const gross = typeBookings.reduce((s, b) => s + Number(b.totalAmount), 0);
      const typeComps = comps.filter((c) => typeBookingIds.has(c.bookingId) && c.status !== 'cancelled'
        && (c.remediationId === null || acceptedRemIds.has(c.remediationId)));
      const compCost = typeComps.reduce((s, c) => s + Number(c.amount), 0);
      const compRatio = gross > 0 ? compCost / gross : 0;
      // 补救接受情况：拒绝/待回应且差评未改评 = 风险未化解
      const typeRems = rems.filter((m) => typeBookingIds.has(m.bookingId)
        && ['accepted', 'rejected', 'proposed'].includes(m.status));
      const accepted = typeRems.filter((m) => m.status === 'accepted').length;
      const unresolved = typeRems.filter((m) => ['rejected', 'proposed'].includes(m.status)).length;
      const typeBadReviews = reviews.filter((r) => typeBookingIds.has(r.bookingId) && (r.originalRating ?? r.rating) <= 3);
      const unrevisedBad = typeBadReviews.filter((r) => r.monitorStatus !== 'revised').length;
      const reasons: string[] = [];
      let reduction = 0;
      if (oversellCount > 0) { reduction += Math.min(2, oversellCount); reasons.push(`超卖 ${oversellCount} 起，预留缓冲房`); }
      if (linenDelayRate > 0.2) { reduction += 1; reasons.push(`布草延迟率 ${round2(linenDelayRate * 100)}%，保洁周转受限`); }
      if (breakfastShortages >= 1) { reduction += 1; reasons.push(`早餐供应不足 ${breakfastShortages} 天，厨房接待能力受限`); }
      if (compRatio > 0.05) { reduction += 1; reasons.push(`已接受补偿成本占收入 ${round2(compRatio * 100)}%，履约风险高`); }
      if (unresolved > 0 || unrevisedBad > 0) {
        reduction += 1;
        reasons.push(`${unresolved} 起补救未被接受、${unrevisedBad} 条差评未改评，渠道评分未恢复，压缩该房型在高风险渠道配额`);
      }
      const adjusted = Math.max(Math.ceil(total / 2), total - reduction);
      return {
        typeId: t.id, typeName: t.name, total, adjustedSellable: adjusted,
        reduction: total - adjusted, oversellCount, breakfastShortages,
        linenDelayRate: round2(linenDelayRate * 100),
        compCost: round2(compCost), totalCompCost: round2(acceptedCost), compRatio: round2(compRatio * 100),
        remediation: { total: typeRems.length, accepted, unresolved, unrevisedBad },
        reasons,
      };
    });
    return { rows };
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
    Remediation, EquipmentLog,
  ])],
  controllers: [AnalyticsController],
})
export class AnalyticsModule {}
