const form = document.getElementById('setupForm');
const feedback = document.getElementById('feedback');
const submitButton = form.querySelector('button[type="submit"]');
async function readJson(response) {
  const raw = await response.text();
  if (!raw) return {};
  try { return JSON.parse(raw); }
  catch {
    const detail = raw.replace(/\s+/g, ' ').trim().slice(0, 180);
    throw new Error(`O servidor retornou uma resposta inválida (HTTP ${response.status}). ${detail}`);
  }
}
function showMessage(text, success = false) {
  feedback.textContent = text;
  feedback.className = success ? 'feedback success' : 'feedback';
}
form.addEventListener('submit', async (event) => {
  event.preventDefault();
  submitButton.disabled = true;
  showMessage('');
  try {
    const response = await fetch('/api/bootstrap', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bootstrapSecret: document.getElementById('bootstrapSecret').value })
    });
    const data = await readJson(response);
    if (!response.ok) throw new Error(data.error || 'Não foi possível criar a conta.');
    document.getElementById('loginPhone').value = data.loginPhone;
    document.getElementById('temporaryPassword').value = data.temporaryPassword;
    document.getElementById('setupFormView').hidden = true;
    document.getElementById('resultView').hidden = false;
    document.getElementById('bootstrapSecret').value = '';
    showMessage(data.message, true);
  } catch (error) {
    showMessage(error.message);
  } finally { submitButton.disabled = false; }
});
document.getElementById('copyCredentials').addEventListener('click', async () => {
  const text = `Telefone: ${document.getElementById('loginPhone').value}\nSenha temporária: ${document.getElementById('temporaryPassword').value}`;
  try { await navigator.clipboard.writeText(text); showMessage('Dados copiados. Guarde-os em local seguro.', true); }
  catch { showMessage('Não foi possível copiar automaticamente. Selecione e copie os campos acima.', false); }
});
