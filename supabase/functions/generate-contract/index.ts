import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";
import { PDFDocument, StandardFonts, rgb } from "npm:pdf-lib@1.17.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "apikey, authorization, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8" },
  });
}

function decodeBase64(value: string) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

async function sha256(bytes: Uint8Array) {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function formatCpf(value: string | null) {
  const digits = String(value || "").replace(/\D/g, "");
  return digits.length === 11 ? digits.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, "$1.$2.$3-$4") : String(value || "");
}

function formatPhone(value: string | null) {
  const digits = String(value || "").replace(/\D/g, "").replace(/^55(?=\d{10,11}$)/, "");
  if (digits.length === 11) return digits.replace(/(\d{2})(\d{5})(\d{4})/, "($1) $2-$3");
  if (digits.length === 10) return digits.replace(/(\d{2})(\d{4})(\d{4})/, "($1) $2-$3");
  return String(value || "");
}

function shiftLabel(shift: string | null) {
  return ({ manha: "Matutino", tarde: "Vespertino", integral: "Integral" } as Record<string, string>)[shift || ""] || "";
}

function drawField(page: ReturnType<PDFDocument["getPages"]>[number], font: Awaited<ReturnType<PDFDocument["embedFont"]>>, value: string, x: number, y: number, maxWidth: number) {
  const content = value.trim();
  if (!content) return;
  let size = 8.2;
  while (size > 5.8 && font.widthOfTextAtSize(content, size) > maxWidth) size -= 0.35;
  const clipped = font.widthOfTextAtSize(content, size) > maxWidth
    ? `${content.slice(0, Math.max(0, Math.floor(content.length * maxWidth / font.widthOfTextAtSize(content, size)) - 1))}…`
    : content;
  page.drawText(clipped, { x, y, size, font, color: rgb(0.06, 0.12, 0.25), maxWidth });
}

// Texto que pode não caber numa linha (endereço, plano): até duas linhas
// menores dentro da mesma célula; a última é reduzida/cortada se precisar.
function drawWrapped(page: ReturnType<PDFDocument["getPages"]>[number], font: Awaited<ReturnType<PDFDocument["embedFont"]>>, value: string, x: number, y: number, maxWidth: number) {
  const content = value.trim();
  if (!content) return;
  if (font.widthOfTextAtSize(content, 8.2) <= maxWidth) return drawField(page, font, content, x, y, maxWidth);
  const size = 7;
  const words = content.split(/\s+/);
  let first = "";
  while (words.length && font.widthOfTextAtSize(`${first} ${words[0]}`.trim(), size) <= maxWidth) first = `${first} ${words.shift()}`.trim();
  page.drawText(first, { x, y: y + 2, size, font, color: rgb(0.06, 0.12, 0.25) });
  drawField(page, font, words.join(" "), x, y - 6.2, maxWidth);
}

// Modelo 2027 (Carta, 2 páginas): quadro no topo da página 1, data e
// assinatura no fim da página 2. Modelo 2025 (A4, 6 páginas): mantido para
// rascunhos gerados antes da troca, que ainda podem ser assinados.
function isTemplate2027(page: ReturnType<PDFDocument["getPages"]>[number]) {
  return Math.round(page.getHeight()) === 792;
}

// Modelo 2027 com a logo (v7, Carta, 3 páginas): o quadro tem rótulo em cima
// e valor embaixo; data, nome e CPF ficam centralizados sob as assinaturas.
function isTemplateV7(pdf: PDFDocument) {
  return pdf.getPageCount() === 3 && isTemplate2027(pdf.getPages()[0]);
}

const INK = rgb(0.12, 0.14, 0.18);

function drawValue(page: ReturnType<PDFDocument["getPages"]>[number], font: Awaited<ReturnType<PDFDocument["embedFont"]>>, value: string, x: number, y: number, maxWidth: number, start = 10) {
  const content = value.trim();
  if (!content) return;
  let size = start;
  while (size > 6.5 && font.widthOfTextAtSize(content, size) > maxWidth) size -= 0.25;
  page.drawText(content, { x, y, size, font, color: INK });
}

function drawCentered(page: ReturnType<PDFDocument["getPages"]>[number], font: Awaited<ReturnType<PDFDocument["embedFont"]>>, value: string, center: number, y: number, size: number, color = INK) {
  const content = value.trim();
  if (content) page.drawText(content, { x: center - font.widthOfTextAtSize(content, size) / 2, y, size, font, color });
}

// Endereço do v7: uma linha em 10pt ou até duas em 9pt.
function drawAddressV7(page: ReturnType<PDFDocument["getPages"]>[number], font: Awaited<ReturnType<PDFDocument["embedFont"]>>, value: string) {
  const content = value.trim();
  const [x, maxWidth] = [212.5, 336];
  if (font.widthOfTextAtSize(content, 10) <= maxWidth) return drawValue(page, font, content, x, 587.7, maxWidth);
  const words = content.split(/\s+/);
  let first = "";
  while (words.length && font.widthOfTextAtSize(`${first} ${words[0]}`.trim(), 9) <= maxWidth) first = `${first} ${words.shift()}`.trim();
  page.drawText(first, { x, y: 588.7, size: 9, font, color: INK });
  drawValue(page, font, words.join(" "), x, 578.7, maxWidth, 9);
}

function money(cents: number) {
  return (cents / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

const MONTHS = ["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"];

function slug(value: string) {
  return value.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "").toLowerCase();
}

// Nome legível no Storage: pasta do responsável, arquivo do aluno. O início
// do id da matrícula impede que homônimos se sobrescrevam.
function contractFilePath(guardianName: string, studentName: string, enrollmentId: string) {
  return `contracts/${slug(guardianName) || "responsavel"}/${slug(studentName) || "aluno"}__${enrollmentId.slice(0, 8)}.pdf`;
}

// O assinado fica ao lado do rascunho de onde saiu.
function signedContractFilePath(generatedPath: string) {
  return generatedPath.replace(/\.pdf$/, "-assinado.pdf");
}

function decodeSignature(value: string) {
  const match = value.match(/^data:image\/(png|jpeg);base64,(.+)$/);
  if (!match) throw new Error("Assinatura desenhada inválida");
  return { type: match[1], bytes: decodeBase64(match[2]) };
}

function signedDate() {
  return new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo" }).format(new Date());
}

async function applySignature(pdfBytes: Uint8Array, signatureData: string) {
  const pdf = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
  const page = pdf.getPages().at(-1);
  if (!page) throw new Error("Página de assinatura não encontrada");
  const signature = decodeSignature(signatureData);
  const image = signature.type === "png" ? await pdf.embedPng(signature.bytes) : await pdf.embedJpg(signature.bytes);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const v7 = isTemplateV7(pdf);
  const modern = isTemplate2027(page);
  // Área da assinatura: sobre a linha do CONTRATANTE.
  const box = v7 ? { x: 76, y: 369, width: 181, height: 36 }
    : modern ? { x: 216, y: 158, width: 180, height: 21 } : { x: 212, y: 379, width: 172, height: 58 };
  const scale = Math.min(box.width / image.width, box.height / image.height);
  const width = image.width * scale;
  const height = image.height * scale;
  page.drawImage(image, { x: box.x + (box.width - width) / 2, y: box.y + (box.height - height) / 2, width, height });

  const [day, month, year] = signedDate().split("/");
  if (v7) {
    // Data por extenso, centralizada como no contrato impresso.
    drawCentered(page, font, `Nanuque/MG, ${day} de ${MONTHS[Number(month) - 1]} de ${year}.`, 306, 437.7, 10);
  } else if (modern) {
    // "Nanuque/MG, ______ de ______________ de 20____."
    const centered = (text: string, start: number, end: number) => {
      const textWidth = font.widthOfTextAtSize(text, 9);
      page.drawText(text, { x: start + (end - start - textWidth) / 2, y: 185, size: 9, font, color: rgb(0.06, 0.12, 0.25) });
    };
    centered(day, 224, 254);
    centered(MONTHS[Number(month) - 1], 269, 399);
    centered(year.slice(2), 425, 444);
  } else {
    // O modelo 2025 traz "____/____/____": dia, mês e ano centralizados em
    // cada espaço, sem escrever por cima das barras.
    const blanks = [[436, 461], [465.5, 491], [495.5, 520.5]];
    [day, month, year].forEach((part, index) => {
      const [start, end] = blanks[index];
      const partWidth = font.widthOfTextAtSize(part, 8.2);
      drawField(page, font, part, start + (end - start - partWidth) / 2, 463, end - start);
    });
  }
  return pdf.save();
}

async function getSession(supabase: SupabaseClient, token: string) {
  const { data, error } = await supabase
    .from("contract_sessions")
    .select("id, guardian_id, campaign_id, status, expires_at")
    .eq("token", token)
    .not("status", "in", "(cancelada,expirada)")
    .gt("expires_at", new Date().toISOString())
    .maybeSingle();
  if (error) throw error;
  return data;
}

async function servePdf(supabase: SupabaseClient, token: string, enrollmentId: string, download = false) {
  const session = await getSession(supabase, token);
  if (!session) return json({ error: "Contrato indisponível" }, 404);
  const { data: acceptance, error } = await supabase
    .from("document_acceptances")
    .select("generated_storage_path, signed_storage_path")
    .eq("contract_session_id", session.id)
    .eq("enrollment_id", enrollmentId)
    .not("generated_storage_path", "is", null)
    // Troca de modelo: a sessão pode ter o aceite antigo e o novo; vale o último.
    .order("generated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  const path = acceptance?.signed_storage_path || acceptance?.generated_storage_path;
  if (!path) return json({ error: "PDF individual ainda não foi gerado" }, 404);
  const { data: file, error: downloadError } = await supabase.storage.from("contract-files").download(path);
  if (downloadError || !file) throw downloadError || new Error("Arquivo não encontrado");
  // download=1 baixa direto (botão "Baixar contrato"); sem ele, abre no visualizador.
  let filename = "contrato-cec.pdf";
  if (download) {
    const { data: enrollment } = await supabase.from("enrollments").select("students(full_name)").eq("id", enrollmentId).maybeSingle();
    const name = slug(String((enrollment as { students?: { full_name?: string } } | null)?.students?.full_name || "aluno"));
    filename = `contrato-cec-${name}${acceptance?.signed_storage_path ? "-assinado" : ""}.pdf`;
  }
  return new Response(await file.arrayBuffer(), {
    headers: {
      ...corsHeaders,
      "Content-Type": "application/pdf",
      "Cache-Control": "private, no-store",
      "Content-Disposition": `${download ? "attachment" : "inline"}; filename=${filename}`,
    },
  });
}

async function generate(supabase: SupabaseClient, token: string, templateBase64: string, onlyIfOutdated = false) {
  const session = await getSession(supabase, token);
  if (!session) return json({ error: "Contrato indisponível" }, 404);
  if (session.status === "assinada") return json({ error: "Este contrato já foi assinado e seu PDF final está preservado." }, 409);
  if (templateBase64.length < 1000 || templateBase64.length > 1_000_000) return json({ error: "Modelo de contrato inválido" }, 422);

  const [guardianResult, enrollmentResult, versionResult] = await Promise.all([
    supabase.from("guardians").select("id, full_name, phone, rg, cpf, address").eq("id", session.guardian_id).single(),
    supabase.from("contract_session_enrollments").select("enrollment_id, enrollments!inner(id, campaign_id, target_grade_id, target_shift, amount_cents, students!inner(full_name), grades!enrollments_target_grade_id_fkey!inner(name), campaigns!inner(academic_year))").eq("contract_session_id", session.id),
    supabase.from("document_versions").select("id, sha256, version, storage_path, documents!inner(code, kind)").eq("is_current", true).eq("documents.code", "contrato_prestacao").maybeSingle(),
  ]);
  if (guardianResult.error) throw guardianResult.error;
  if (enrollmentResult.error) throw enrollmentResult.error;
  if (versionResult.error) throw versionResult.error;
  if (!versionResult.data?.sha256) return json({ error: "Versão contratual indisponível" }, 409);

  // Abertura da página: só refaz o rascunho se ele não for do modelo atual
  // (ex.: gerado antes da troca para o contrato 2027).
  if (onlyIfOutdated) {
    const { data: current } = await supabase.from("document_acceptances")
      .select("enrollment_id").eq("contract_session_id", session.id)
      .eq("document_version_id", versionResult.data.id).not("generated_storage_path", "is", null);
    const done = new Set((current || []).map((item) => item.enrollment_id));
    if ((enrollmentResult.data || []).every((row: any) => done.has(row.enrollment_id))) return json({ ok: true, unchanged: true });
  }

  // Modelo guardado no Storage ("storage:<caminho>"): o servidor usa o próprio
  // arquivo e ignora o que veio da página, para trocar o modelo sem publicar o site.
  const storagePath = String(versionResult.data.storage_path || "");
  let template = decodeBase64(templateBase64);
  if (storagePath.startsWith("storage:")) {
    const { data: file, error: fileError } = await supabase.storage.from("contract-files").download(storagePath.slice(8));
    if (fileError || !file) throw fileError || new Error("Modelo do contrato não encontrado");
    template = new Uint8Array(await file.arrayBuffer());
  }
  if (await sha256(template) !== versionResult.data.sha256) return json({ error: "O modelo do contrato não confere com a versão publicada pela escola" }, 409);
  const guardian = guardianResult.data;
  const rows = enrollmentResult.data || [];
  if (!guardian.full_name || !guardian.phone || !guardian.rg || !guardian.cpf || !guardian.address) {
    return json({ error: "Conclua os dados obrigatórios do responsável antes de gerar o contrato" }, 422);
  }
  if (!rows.length || rows.some((row: any) => !row.enrollments.students?.full_name || !row.enrollments.target_grade_id || !row.enrollments.target_shift)) {
    return json({ error: "Conclua os dados obrigatórios do aluno antes de gerar o contrato" }, 422);
  }

  await supabase.storage.createBucket("contract-files", { public: false, fileSizeLimit: "5MB", allowedMimeTypes: ["application/pdf"] }).catch(() => null);
  const files: Array<{ enrollment_id: string; path: string; hash: string }> = [];
  for (const row of rows as any[]) {
    const enrollment = row.enrollments;
    const path = contractFilePath(guardian.full_name, enrollment.students.full_name, row.enrollment_id);
    const { data: existing } = await supabase
      .from("document_acceptances")
      .select("contract_session_id, generated_storage_path, generated_document_hash, signed_storage_path, signed_document_hash, status")
      .eq("enrollment_id", row.enrollment_id)
      .eq("document_version_id", versionResult.data.id)
      .maybeSingle();
    if (existing?.status === "assinado") {
      return json({ error: "Este contrato já foi assinado e seu PDF final está preservado." }, 409);
    }
    const pdf = await PDFDocument.load(template, { ignoreEncryption: true });
    const page = pdf.getPages()[0];
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    // Valor que a família paga na matrícula: soma das parcelas do plano
    // escolhido (já com desconto); sem parcelas ainda, o preço travado.
    const { data: planRows } = await supabase.from("installments")
      .select("amount_cents").eq("enrollment_id", row.enrollment_id).neq("status", "cancelado");
    const fee = (planRows || []).reduce((total, item) => total + Number(item.amount_cents || 0), 0) || Number(enrollment.amount_cents) || 0;
    if (isTemplateV7(pdf)) {
      // Quadro do v7. Anuidade, vencimento e plano são negociados depois e
      // ficam em branco; a 1ª parcela é o valor da matrícula (já com desconto).
      drawValue(page, font, guardian.full_name, 63, 622, 376);
      drawValue(page, font, formatCpf(guardian.cpf), 451.9, 622, 97);
      drawValue(page, font, formatPhone(guardian.phone), 63, 587.7, 137);
      drawAddressV7(page, font, guardian.address);
      drawValue(page, font, enrollment.students.full_name, 63, 514.6, 246);
      drawValue(page, font, enrollment.grades.name, 322.2, 514.6, 117);
      drawValue(page, font, shiftLabel(enrollment.target_shift), 451.9, 514.6, 97);
      if (fee > 0) drawValue(page, font, money(fee), 63, 439.6, 246);
      const last = pdf.getPages()[2];
      drawCentered(last, font, guardian.full_name, 166.4, 339.8, 8);
      drawCentered(last, font, `CPF: ${formatCpf(guardian.cpf)}`, 166.4, 329.7, 7.5, rgb(0.42, 0.45, 0.5));
    } else if (isTemplate2027(page)) {
      // Quadro do modelo 2027. O RG continua no cadastro; o modelo não tem o campo.
      drawField(page, font, guardian.full_name, 86, 691.3, 246);
      drawField(page, font, formatCpf(guardian.cpf), 363, 691.3, 193);
      drawField(page, font, formatPhone(guardian.phone), 93, 670, 239);
      drawWrapped(page, font, guardian.address, 383, 670, 173);
      drawField(page, font, enrollment.students.full_name, 85, 606.4, 247);
      drawField(page, font, enrollment.grades.name, 385, 606.4, 52);
      drawField(page, font, shiftLabel(enrollment.target_shift), 468, 606.4, 88);
      // Condições financeiras são acordadas individualmente e ficam em branco
      // neste PDF (anuidade, vencimento e plano); a 1ª parcela é a matrícula.
      drawField(page, font, "Matrícula", 142, 562.7, 190);
    } else {
      drawField(page, font, guardian.full_name, 84, 734, 450);
      drawField(page, font, guardian.phone, 93, 714, 441);
      drawField(page, font, guardian.rg, 71, 694, 241);
      drawField(page, font, guardian.cpf, 351, 694, 183);
      drawField(page, font, guardian.address, 101, 673, 433);
      drawField(page, font, enrollment.students.full_name, 81, 622, 453);
      drawField(page, font, enrollment.grades.name, 98, 602, 110);
      drawField(page, font, shiftLabel(enrollment.target_shift), 252, 602, 282);
    }
    const output = await pdf.save();
    const outputHash = await sha256(output);
    // A correção dos dados invalida o rascunho antes da assinatura. O mesmo
    // caminho é sobrescrito com o PDF novo; cópias já assinadas nunca chegam
    // aqui porque a sessão é bloqueada pelo banco.
    const { error: uploadError } = await supabase.storage.from("contract-files").upload(path, output, { contentType: "application/pdf", upsert: true });
    if (uploadError) throw uploadError;
    const generationData = {
      template_version: versionResult.data.version,
      guardian: { full_name: guardian.full_name, phone: guardian.phone, rg: guardian.rg, cpf: guardian.cpf, address: guardian.address },
      student: { full_name: enrollment.students.full_name, grade: enrollment.grades.name, shift: shiftLabel(enrollment.target_shift) },
      enrollment_fee_cents: fee || null,
    };
    const { error: acceptanceError } = await supabase.from("document_acceptances").upsert({
      enrollment_id: row.enrollment_id,
      document_version_id: versionResult.data.id,
      contract_session_id: session.id,
      status: "pendente",
      provider: "cec_contrato_gerado",
      generated_storage_path: path,
      generated_document_hash: outputHash,
      generated_at: new Date().toISOString(),
      generation_data: generationData,
      document_hash: outputHash,
    }, { onConflict: "enrollment_id,document_version_id" });
    if (acceptanceError) throw acceptanceError;
    files.push({ enrollment_id: row.enrollment_id, path, hash: outputHash });
  }
  return json({ ok: true, files: files.map((file) => ({ enrollment_id: file.enrollment_id, sha256: file.hash })) });
}

async function sign(supabase: SupabaseClient, token: string, signerName: string, signatureData: string, accepted: boolean, request: Request) {
  if (!accepted) return json({ error: "Confirme a leitura e o aceite do contrato" }, 422);
  if (signerName.trim().length < 3) return json({ error: "Informe o nome completo de quem assina" }, 422);
  if (!/^data:image\/(png|jpeg);base64,/.test(signatureData) || signatureData.length < 100 || signatureData.length > 500_000) {
    return json({ error: "A assinatura desenhada é obrigatória" }, 422);
  }
  const session = await getSession(supabase, token);
  if (!session) return json({ error: "Contrato indisponível" }, 404);
  const { data: verification, error: verificationError } = await supabase
    .from("contract_sessions")
    .select("verification_verified_at")
    .eq("id", session.id)
    .single();
  if (verificationError) throw verificationError;
  if (!verification?.verification_verified_at) return json({ error: "Confirme o código enviado por e-mail antes de assinar" }, 422);

  const { data: acceptances, error: acceptanceError } = await supabase
    .from("document_acceptances")
    .select("id, enrollment_id, document_version_id, generated_storage_path, generated_document_hash, signed_storage_path, signed_document_hash, status")
    .eq("contract_session_id", session.id);
  if (acceptanceError) throw acceptanceError;
  // Vale só o contrato do modelo atual; um rascunho antigo da mesma sessão é ignorado.
  const { data: currentVersion } = await supabase.from("document_versions")
    .select("id, documents!inner(code)").eq("is_current", true).eq("documents.code", "contrato_prestacao").maybeSingle();
  const { data: sessionEnrollments } = await supabase.from("contract_session_enrollments")
    .select("enrollment_id").eq("contract_session_id", session.id);
  const current = (acceptances || []).filter((item) => !currentVersion?.id || item.document_version_id === currentVersion.id);
  const covered = new Set(current.map((item) => item.enrollment_id));
  if ((sessionEnrollments || []).some((item) => !covered.has(item.enrollment_id))) {
    return json({ error: "O contrato foi atualizado. Recarregue a página para ver a versão nova antes de assinar." }, 409);
  }
  if (!current.length || current.some((item) => !item.generated_storage_path || !item.generated_document_hash)) {
    return json({ error: "O PDF individual precisa ser gerado antes da assinatura" }, 422);
  }

  for (const acceptance of current) {
    // Enquanto a finalização ainda não aconteceu, uma nova tentativa pode
    // substituir apenas o rascunho assinado. Depois de finalizado, o banco
    // bloqueia a sessão e o arquivo final não é alterado.
    if (acceptance.status === "assinado") continue;
    const { data: source, error: sourceError } = await supabase.storage.from("contract-files").download(acceptance.generated_storage_path);
    if (sourceError || !source) throw sourceError || new Error("PDF individual não encontrado");
    const signedPdf = await applySignature(new Uint8Array(await source.arrayBuffer()), signatureData);
    const signedHash = await sha256(signedPdf);
    const path = signedContractFilePath(acceptance.generated_storage_path);
    const { error: uploadError } = await supabase.storage.from("contract-files").upload(path, signedPdf, { contentType: "application/pdf", upsert: true });
    if (uploadError) throw uploadError;
    const { error: updateError } = await supabase
      .from("document_acceptances")
      .update({ signed_storage_path: path, signed_document_hash: signedHash, signed_pdf_at: new Date().toISOString() })
      .eq("id", acceptance.id);
    if (updateError) throw updateError;
  }

  const { data, error } = await supabase.rpc("contract_finalize_signed_pdf", {
    p_token: token,
    p_signer_full_name: signerName.trim(),
    p_signature_image_data: signatureData,
    p_accepted: true,
    p_ip: request.headers.get("x-forwarded-for"),
    p_user_agent: request.headers.get("user-agent"),
    p_device: request.headers.get("sec-ch-ua-mobile"),
  });
  if (error) throw error;
  return json(data);
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRole = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRole) return json({ error: "Configuração interna ausente" }, 500);
  const supabase = createClient(supabaseUrl, serviceRole, { auth: { persistSession: false } });
  try {
    const url = new URL(request.url);
    if (request.method === "GET") {
      return await servePdf(supabase, url.searchParams.get("token") || "", url.searchParams.get("enrollment_id") || "", url.searchParams.get("download") === "1");
    }
    if (request.method !== "POST") return json({ error: "Método não suportado" }, 405);
    const body = await request.json();
    if (body?.action === "sign") {
      return await sign(supabase, String(body?.token || ""), String(body?.signer_name || ""), String(body?.signature_image_data || ""), body?.accepted === true, request);
    }
    return await generate(supabase, String(body?.token || ""), String(body?.template_base64 || ""), body?.only_if_outdated === true);
  } catch (error) {
    console.error(error);
    return json({ error: error instanceof Error ? error.message : "Não foi possível gerar o contrato" }, 500);
  }
});
