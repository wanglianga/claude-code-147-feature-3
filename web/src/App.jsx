import React from 'react';
import { BrowserRouter, Routes, Route, Navigate, useNavigate, useLocation } from 'react-router-dom';
import { Layout, Menu, Dropdown, Avatar, Tag } from 'antd';
import {
  DashboardOutlined, CalendarOutlined, BookOutlined, ClearOutlined,
  CoffeeOutlined, ToolOutlined, AlertOutlined, AccountBookOutlined,
  LineChartOutlined, UserOutlined, LogoutOutlined, FrownOutlined,
} from '@ant-design/icons';
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import CalendarPage from './pages/Calendar';
import Bookings from './pages/Bookings';
import Cleaning from './pages/Cleaning';
import Breakfast from './pages/Breakfast';
import Maintenance from './pages/Maintenance';
import Incidents from './pages/Incidents';
import ReviewCenter from './pages/ReviewCenter';
import Settlements from './pages/Settlements';
import Analytics from './pages/Analytics';

const { Sider, Header, Content } = Layout;

const MENU = [
  { key: '/', icon: <DashboardOutlined />, label: '经营看板' },
  { key: '/calendar', icon: <CalendarOutlined />, label: '房态日历' },
  { key: '/bookings', icon: <BookOutlined />, label: '订单管理' },
  { key: '/cleaning', icon: <ClearOutlined />, label: '保洁与布草' },
  { key: '/breakfast', icon: <CoffeeOutlined />, label: '早餐备餐' },
  { key: '/maintenance', icon: <ToolOutlined />, label: '维修工单' },
  { key: '/incidents', icon: <AlertOutlined />, label: '事件与差评' },
  { key: '/reviews', icon: <FrownOutlined />, label: '差评复盘' },
  { key: '/settlements', icon: <AccountBookOutlined />, label: '结算中心' },
  { key: '/analytics', icon: <LineChartOutlined />, label: '旺季复盘' },
];

const ROLE_NAMES = { owner: '店主', housekeeper: '管家', cleaner: '保洁', kitchen: '厨房', frontdesk: '前台' };

function Shell({ children }) {
  const navigate = useNavigate();
  const location = useLocation();
  const user = JSON.parse(localStorage.getItem('user') || '{}');
  const selected = MENU.find((m) => (m.key === '/' ? location.pathname === '/' : location.pathname.startsWith(m.key)))?.key || '/';
  return (
    <Layout style={{ minHeight: '100vh' }}>
      <Sider theme="dark" width={208}>
        <div style={{ color: '#fff', padding: '18px 16px', fontWeight: 700, fontSize: 15, lineHeight: 1.4 }}>
          云溪山居民宿<br /><span style={{ fontSize: 12, fontWeight: 400, color: '#9fd3b8' }}>旺季运营平台 · 2026国庆</span>
        </div>
        <Menu theme="dark" mode="inline" selectedKeys={[selected]} items={MENU}
          onClick={({ key }) => navigate(key)} />
      </Sider>
      <Layout>
        <Header style={{ background: '#fff', padding: '0 24px', display: 'flex', justifyContent: 'flex-end', alignItems: 'center', boxShadow: '0 1px 4px rgba(0,0,0,.08)', zIndex: 1 }}>
          <Dropdown menu={{
            items: [{ key: 'logout', icon: <LogoutOutlined />, label: '退出登录', onClick: () => { localStorage.clear(); navigate('/login'); } }],
          }}>
            <span style={{ cursor: 'pointer' }}>
              <Avatar icon={<UserOutlined />} style={{ marginRight: 8, background: '#2f6b4f' }} />
              {user.name || user.username} <Tag color="green" style={{ marginLeft: 6 }}>{ROLE_NAMES[user.role] || user.role}</Tag>
            </span>
          </Dropdown>
        </Header>
        <Content style={{ padding: 20, background: '#f3f5f4' }}>{children}</Content>
      </Layout>
    </Layout>
  );
}

function Guard({ children }) {
  return localStorage.getItem('token') ? <Shell>{children}</Shell> : <Navigate to="/login" replace />;
}

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/" element={<Guard><Dashboard /></Guard>} />
        <Route path="/calendar" element={<Guard><CalendarPage /></Guard>} />
        <Route path="/bookings" element={<Guard><Bookings /></Guard>} />
        <Route path="/cleaning" element={<Guard><Cleaning /></Guard>} />
        <Route path="/breakfast" element={<Guard><Breakfast /></Guard>} />
        <Route path="/maintenance" element={<Guard><Maintenance /></Guard>} />
        <Route path="/incidents" element={<Guard><Incidents /></Guard>} />
        <Route path="/reviews" element={<Guard><ReviewCenter /></Guard>} />
        <Route path="/settlements" element={<Guard><Settlements /></Guard>} />
        <Route path="/analytics" element={<Guard><Analytics /></Guard>} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
