import { Navigate, Route, Routes, useParams } from 'react-router-dom';
import Layout from './components/Layout';
import Dashboard from './pages/Dashboard';
import Jornadas from './pages/Jornadas';
import Familias from './pages/Familias';
import FamilyDetail from './pages/FamilyDetail';
import Matriculados from './pages/Matriculados';
import Assinaturas from './pages/Assinaturas';
import Pagamentos from './pages/Pagamentos';
import Extrato from './pages/Extrato';
import Configuracoes from './pages/Configuracoes';
import LinkRematricula from './pages/LinkRematricula';
import ContractSignature from './pages/ContractSignature';
import LinkMatricula from './pages/LinkMatricula';
import LinkGenerator from './pages/LinkGenerator';
import AuthGate from './components/AuthGate';
import EnrollmentOnboarding from './pages/EnrollmentOnboarding';

/* Link antigo da subaba de assinatura: abre a aba Contrato da ficha. */
function LegacyFamilyContract() {
  const { id } = useParams();
  return <Navigate to={`/familias/${id}?aba=contrato`} replace />;
}

/* Uma rota por tela. A ficha da família guarda a aba na URL (?aba=), então
   recarregar ou compartilhar o endereço cai na mesma aba. */
export default function App() {
  return (
    <Routes>
      <Route path="matricula" element={<EnrollmentOnboarding />} />
      <Route path="matricula/:token" element={<LinkMatricula />} />
      <Route path="rematricula" element={<EnrollmentOnboarding initialFlow="rematricula" />} />
      <Route path="rematricula/:token" element={<LinkRematricula />} />
      <Route path="contrato/:token" element={<ContractSignature />} />
      <Route element={<AuthGate><Layout /></AuthGate>}>
        <Route index element={<Navigate to="/jornadas" replace />} />
        <Route path="dashboard" element={<Dashboard />} />
        <Route path="jornadas" element={<Jornadas />} />
        <Route path="links" element={<LinkGenerator />} />

        <Route path="familias" element={<Familias />} />
        <Route path="familias/:id" element={<FamilyDetail />} />
        <Route path="familias/:id/assinatura" element={<LegacyFamilyContract />} />

        <Route path="matriculas-novas" element={<Navigate to="/familias?tipo=matricula_nova" replace />} />
        <Route path="matriculados" element={<Matriculados />} />
        <Route path="assinaturas" element={<Assinaturas />} />
        <Route path="pagamentos" element={<Pagamentos />} />
        <Route path="financeiro/extrato" element={<Extrato />} />
        <Route path="assinatura-e-pagamento" element={<Navigate to="/assinaturas" replace />} />
        <Route path="configuracoes" element={<Configuracoes />} />

        <Route path="*" element={<Navigate to="/dashboard" replace />} />
      </Route>
    </Routes>
  );
}
