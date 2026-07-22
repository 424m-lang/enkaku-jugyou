import { Routes, Route, Navigate } from 'react-router-dom';
import Login from './pages/teacher/Login';
import Register from './pages/teacher/Register';
import Dashboard from './pages/teacher/Dashboard';
import Teach from './pages/teacher/Teach';
import Screen from './pages/teacher/Screen';
import Review from './pages/teacher/Review';
import Join from './pages/student/Join';
import Class from './pages/student/Class';
import Watch from './pages/Watch';

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Navigate to="/login" replace />} />
      <Route path="/login" element={<Login />} />
      <Route path="/register" element={<Register />} />
      <Route path="/dashboard" element={<Dashboard />} />
      <Route path="/teach/:id" element={<Teach />} />
      <Route path="/screen/:id" element={<Screen />} />
      <Route path="/review/:id" element={<Review />} />
      <Route path="/join" element={<Join />} />
      <Route path="/class" element={<Class />} />
      {/* 生徒向けの復習ページ（ログイン不要・公開トークン） */}
      <Route path="/watch/:token" element={<Watch />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
