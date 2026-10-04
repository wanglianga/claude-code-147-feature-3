import {
  Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn, Unique,
} from 'typeorm';

const numTransformer = {
  to: (v: any) => v,
  from: (v: any) => (v === null || v === undefined ? null : Number(v)),
};
const Money = (opts: any = {}) =>
  Column({ type: 'numeric', precision: 12, scale: 2, default: 0, transformer: numTransformer, ...opts });

// ---------- 用户 ----------
@Entity('users')
export class User {
  @PrimaryGeneratedColumn() id: number;
  @Column({ unique: true }) username: string;
  @Column() passwordHash: string;
  @Column() name: string;
  @Column() role: string; // owner 店主 | housekeeper 管家 | cleaner 保洁 | kitchen 厨房 | frontdesk 前台
  @CreateDateColumn() createdAt: Date;
}

// ---------- 房型 / 房间 / 渠道 ----------
@Entity('room_types')
export class RoomType {
  @PrimaryGeneratedColumn() id: number;
  @Column({ unique: true }) code: string;
  @Column() name: string;
  @Money() basePrice: number;
  @Column({ default: 2 }) maxAdults: number;
  @Column({ default: 1 }) maxChildren: number;
  @Column({ default: false }) extraBedAllowed: boolean;
  @Money() extraBedPrice: number;
  @Column({ default: false }) petAllowed: boolean;
  @Money() petFee: number; // 宠物清洁费（一次性）
  @Money() breakfastPrice: number; // 早餐单价/份/天
  @Money() depositAmount: number; // 押金
}

@Entity('rooms')
export class Room {
  @PrimaryGeneratedColumn() id: number;
  @Column({ unique: true }) code: string;
  @Column({ default: 1 }) floor: number;
  // 保洁状态：clean 已清洁 | dirty 待打扫 | cleaning 打扫中 | inspected 已验收 | maintenance 维修中
  @Column({ default: 'clean' }) status: string;
  @Column() roomTypeId: number;
  @ManyToOne(() => RoomType) @JoinColumn({ name: 'roomTypeId' }) roomType: RoomType;
}

@Entity('channels')
export class Channel {
  @PrimaryGeneratedColumn() id: number;
  @Column({ unique: true }) code: string; // web | miniapp | ota | phone
  @Column() name: string;
  @Column({ type: 'numeric', precision: 5, scale: 4, default: 0, transformer: numTransformer })
  commissionRate: number; // 渠道佣金比例
}

// ---------- 价格与库存 ----------
@Entity('daily_prices')
@Unique(['roomTypeId', 'date'])
export class DailyPrice {
  @PrimaryGeneratedColumn() id: number;
  @Column() roomTypeId: number;
  @Column({ type: 'date' }) date: string;
  @Money() price: number;
}

@Entity('daily_inventory')
@Unique(['roomTypeId', 'date'])
export class DailyInventory {
  @PrimaryGeneratedColumn() id: number;
  @Column() roomTypeId: number;
  @Column({ type: 'date' }) date: string;
  @Column({ default: 0 }) total: number;    // 物理房量
  @Column({ default: 0 }) sellable: number; // 系统调整后的可售房量
  @Column({ default: 0 }) booked: number;   // 已订
}

// ---------- 订单 ----------
@Entity('bookings')
export class Booking {
  @PrimaryGeneratedColumn() id: number;
  @Column({ unique: true }) code: string;
  @Column() channelId: number;
  @ManyToOne(() => Channel) @JoinColumn({ name: 'channelId' }) channel: Channel;
  @Column() roomId: number;
  @ManyToOne(() => Room) @JoinColumn({ name: 'roomId' }) room: Room;
  @Column() roomTypeId: number;
  @ManyToOne(() => RoomType) @JoinColumn({ name: 'roomTypeId' }) roomType: RoomType;

  @Column() guestName: string;
  @Column({ default: '' }) guestPhone: string;
  @Column({ type: 'date' }) checkIn: string;
  @Column({ type: 'date' }) checkOut: string;
  @Column() nights: number;
  @Column({ default: 2 }) adults: number;
  @Column({ default: 0 }) children: number;
  @Column({ default: 0 }) extraBeds: number;
  @Column({ default: 0 }) pets: number;
  @Column({ default: 0 }) breakfastCount: number; // 每日早餐份数
  @Column({ default: '' }) dietaryNotes: string;  // 忌口
  @Column({ default: false }) invoiceRequired: boolean;
  @Column({ default: '' }) invoiceTitle: string;
  @Column({ default: '' }) specialRequests: string;

  @Money() roomFee: number;
  @Money() extraBedFee: number;
  @Money() breakfastFee: number;
  @Money() petFee: number;
  @Money() totalAmount: number;
  @Money() depositAmount: number;
  @Money() depositDeducted: number; // 押金扣款（如宠物损坏）
  @Money() depositReturned: number;

  // booked | checked_in | checked_out | cancelled
  @Column({ default: 'booked' }) status: string;
  @Column({ type: 'timestamptz', nullable: true }) actualCheckIn: Date;
  @Column({ type: 'timestamptz', nullable: true }) actualCheckOut: Date;
  @CreateDateColumn() createdAt: Date;
}

// ---------- 保洁 ----------
@Entity('cleaning_tasks')
export class CleaningTask {
  @PrimaryGeneratedColumn() id: number;
  @Column() roomId: number;
  @ManyToOne(() => Room) @JoinColumn({ name: 'roomId' }) room: Room;
  @Column({ nullable: true }) bookingId: number;
  @Column({ type: 'date' }) date: string;
  @Column({ default: 'normal' }) dirtiness: string; // light | normal | heavy
  // pending | assigned | in_progress | done | inspected
  @Column({ default: 'pending' }) status: string;
  @Column({ nullable: true }) assigneeId: number;
  @ManyToOne(() => User, { nullable: true }) @JoinColumn({ name: 'assigneeId' }) assignee: User;
  @Column({ type: 'timestamptz', nullable: true }) scheduledStart: Date;
  @Column({ type: 'timestamptz', nullable: true }) startedAt: Date;
  @Column({ type: 'timestamptz', nullable: true }) finishedAt: Date;
  @Column({ default: 0 }) linenUsed: number; // 更换布草套数
  @Column({ default: 0 }) priority: number;
  @Column({ default: '' }) notes: string;
}

// ---------- 布草 ----------
@Entity('linen_items')
export class LinenItem {
  @PrimaryGeneratedColumn() id: number;
  @Column({ unique: true }) item: string; // 床单/被套/毛巾/枕套
  @Column({ default: 0 }) total: number;
  @Column({ default: 0 }) inUse: number;
  @Column({ default: 0 }) inWash: number;
  @Column({ default: 0 }) damaged: number;
}

@Entity('linen_deliveries')
export class LinenDelivery {
  @PrimaryGeneratedColumn() id: number;
  @Column() item: string;
  @Column() quantity: number;
  @Column({ type: 'timestamptz' }) expectedAt: Date;
  @Column({ type: 'timestamptz', nullable: true }) arrivedAt: Date;
  @Column({ default: 'scheduled' }) status: string; // scheduled | delivered | delayed
  @CreateDateColumn() createdAt: Date;
}

// ---------- 维修 ----------
@Entity('maintenance_tickets')
export class MaintenanceTicket {
  @PrimaryGeneratedColumn() id: number;
  @Column() roomId: number;
  @ManyToOne(() => Room) @JoinColumn({ name: 'roomId' }) room: Room;
  @Column({ nullable: true }) bookingId: number;
  @Column() type: string; // ac | plumbing | furniture | appliance | other
  @Column() description: string;
  @Column({ default: 'open' }) status: string; // open | fixing | fixed
  @Money() cost: number;
  @CreateDateColumn() reportedAt: Date;
  @Column({ type: 'timestamptz', nullable: true }) fixedAt: Date;
}

// ---------- 早餐 ----------
@Entity('breakfast_preps')
export class BreakfastPrep {
  @PrimaryGeneratedColumn() id: number;
  @Column({ type: 'date', unique: true }) date: string;
  @Column({ default: 0 }) requiredPortions: number;
  @Column({ default: 0 }) preparedPortions: number;
  @Column({ default: 'planned' }) status: string; // planned | confirmed | shortage
  @Column({ default: '' }) note: string;
  @Column({ type: 'timestamptz', nullable: true }) confirmedAt: Date;
}

// ---------- 事件（住宿链路） ----------
@Entity('incidents')
export class Incident {
  @PrimaryGeneratedColumn() id: number;
  // late_checkout 延迟退房 | ac_failure 空调故障 | linen_delay 布草延迟 | extra_guests 临时加人
  // pet_damage 宠物损坏 | breakfast_shortage 早餐不足 | oversell 渠道超卖 | bad_review 差评 | other
  @Column() @Index() type: string;
  @Column({ nullable: true }) @Index() bookingId: number;
  @Column({ nullable: true }) roomId: number;
  @Column({ type: 'text' }) description: string;
  @Column({ default: 'open' }) status: string; // open | processing | resolved
  @Money() cost: number;
  @Column({ type: 'timestamptz', default: () => 'now()' }) occurredAt: Date;
  @Column({ type: 'timestamptz', nullable: true }) resolvedAt: Date;
  @Column({ default: '' }) resolution: string;
}

// ---------- 差评与补偿 ----------
@Entity('reviews')
export class Review {
  @PrimaryGeneratedColumn() id: number;
  @Column() bookingId: number;
  @ManyToOne(() => Booking) @JoinColumn({ name: 'bookingId' }) booking: Booking;
  @Column() rating: number; // 1-5，<=3 为差评（当前评分，客人修改后更新）
  @Column() category: string; // hardware 硬件 | service 服务 | oversell 超卖 | food 餐食
  @Column({ type: 'text' }) content: string;
  @Column({ default: false }) compensated: boolean;
  @Column({ default: false }) watching: boolean; // 补救完成后持续观察客人是否修改差评
  @CreateDateColumn() createdAt: Date;
}

// 差评归因维度：一条差评可挂多个归因（早餐少/房间潮湿/入住等待久…）
@Entity('review_issues')
export class ReviewIssue {
  @PrimaryGeneratedColumn() id: number;
  @Column() reviewId: number;
  // breakfast 早餐供应 | damp 房间潮湿 | checkin_wait 入住等待 | ac 空调硬件
  // hygiene 卫生 | service 服务 | oversell 超卖 | other 其他
  @Column() dimension: string;
  @Column({ default: '' }) detail: string;
  @Column({ default: 'pending' }) status: string; // pending 待核实 | confirmed 属实 | rejected 不成立
  @Column({ default: '' }) evidenceNote: string; // 核实结论（对应复盘页证据）
  @CreateDateColumn() createdAt: Date;
}

// 除湿等设备运行记录（复盘页证据之一）
@Entity('equipment_logs')
export class EquipmentLog {
  @PrimaryGeneratedColumn() id: number;
  @Column() roomId: number;
  @ManyToOne(() => Room) @JoinColumn({ name: 'roomId' }) room: Room;
  @Column() device: string; // 除湿机 | 空调 | 新风
  @Column({ type: 'timestamptz' }) recordedAt: Date;
  @Column({ type: 'int', nullable: true }) humidity: number; // 湿度 %
  @Column({ default: 'normal' }) status: string; // normal | fault | offline
  @Column({ default: '' }) note: string;
}

// 管家沟通记录（复盘页证据之一）
@Entity('butler_messages')
export class ButlerMessage {
  @PrimaryGeneratedColumn() id: number;
  @Column() bookingId: number;
  @ManyToOne(() => Booking) @JoinColumn({ name: 'bookingId' }) booking: Booking;
  @Column({ type: 'timestamptz' }) sentAt: Date;
  @Column({ default: '微信' }) channel: string; // 微信 | 电话 | 短信 | 到店
  @Column() direction: string; // guest 客人→管家 | butler 管家→客人
  @Column({ type: 'text' }) content: string;
  @Column({ default: '' }) handlerName: string; // 处理人（管家）
}

// 补救决策：退款 / 补偿券 / 电话道歉 / 不予补偿，并跟踪客人是否接受
@Entity('remediations')
export class Remediation {
  @PrimaryGeneratedColumn() id: number;
  @Column() reviewId: number;
  @Column() bookingId: number;
  @Column() action: string; // refund 退款 | voucher 补偿券 | phone_apology 电话道歉 | none 不予补偿
  @Money() amount: number;
  @Column({ nullable: true }) voucherCode: string;
  // pending 待客人回应 | accepted 客人接受 | rejected 客人拒绝 | closed 已关闭（不予补偿）
  @Column({ default: 'pending' }) status: string;
  @Column({ default: '' }) note: string;
  @Column({ default: '' }) createdBy: string; // 决策人（店主/管家）
  @Column({ nullable: true }) compensationId: number; // 关联的补偿记录（退款/补偿券）
  @Column({ type: 'timestamptz', nullable: true }) respondedAt: Date;
  @Column({ default: '' }) guestNote: string; // 客人回应备注
  @CreateDateColumn() createdAt: Date;
}

// 差评修改观察：客人修改评分/内容的历史
@Entity('review_amendments')
export class ReviewAmendment {
  @PrimaryGeneratedColumn() id: number;
  @Column() reviewId: number;
  @Column() oldRating: number;
  @Column() newRating: number;
  @Column({ type: 'text', default: '' }) oldContent: string;
  @Column({ type: 'text', default: '' }) newContent: string;
  @Column({ type: 'timestamptz', default: () => 'now()' }) amendedAt: Date;
}

@Entity('compensations')
export class Compensation {
  @PrimaryGeneratedColumn() id: number;
  @Column({ nullable: true }) reviewId: number;
  @Column({ nullable: true }) incidentId: number;
  @Column({ nullable: true }) bookingId: number;
  @Column() type: string; // cash 现金 | voucher 补偿券 | refund 退款
  @Money() amount: number;
  @Column({ nullable: true }) voucherCode: string;
  @Column({ default: 'issued' }) status: string; // issued | used | cancelled
  @Column({ default: '' }) reason: string;
  @CreateDateColumn() createdAt: Date;
}

export const ALL_ENTITIES = [
  User, RoomType, Room, Channel, DailyPrice, DailyInventory, Booking,
  CleaningTask, LinenItem, LinenDelivery, MaintenanceTicket, BreakfastPrep,
  Incident, Review, Compensation,
  ReviewIssue, EquipmentLog, ButlerMessage, Remediation, ReviewAmendment,
];
