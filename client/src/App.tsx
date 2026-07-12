import { Routes, Route, Navigate } from 'react-router-dom';
import Login from './pages/teacher/Login';
import Register from './pages/teacher/Register';
import Dashboard from './pages/teacher/Dashboard';
import Teach from './pages/teacher/Teach';
import Review from './pages/teacher/Review';
import Join from './pages/student/Join';
import Class from './pages/student/Class';

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Navigate to="/login" replace />} />
      <Route path="/login" element={<Login />} />
      <Route path="/register" element={<Register />} />
      <Route path="/dashboard" element={<Dashboard />} />
      <Route path="/teach/:id" element={<Teach />} />
      <Route path="/review/:id" element={<Review />} />
      <Route path="/join" element={<Join />} />
      <Route path="/class" element={<Class />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
