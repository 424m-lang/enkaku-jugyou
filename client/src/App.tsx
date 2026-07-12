import { Routes, Route, Navigate } from 'react-router-dom';
import Login from './pages/teacher/Login';
import Register from './pages/teacher/Register';
import Dashboard from './pages/teacher/Dashboard';
import Teach from './pages/teacher/Teach';
import Join from './pages/student/Join';
import Class from './pages/student/Class';

function ReviewPlaceholder() {
  return (
    <div className="page-center">
      <h1>振り返り画面（実装中）</h1>
    </div>
  );
}

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Navigate to="/login" replace />} />
      <Route path="/login" element={<Login />} />
      <Route path="/register" element={<Register />} />
      <Route path="/dashboard" element={<Dashboard />} />
      <Route path="/teach/:id" element={<Teach />} />
      <Route path="/review/:id" element={<ReviewPlaceholder />} />
      <Route path="/join" element={<Join />} />
      <Route path="/class" element={<Class />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
