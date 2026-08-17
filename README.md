# SIX

Slogan: **A Nossa Rede Social**

SIX e uma rede social escolar para intranet, feita em Node.js, tema escuro e banco SQLite. Ela implementa cadastro por e-mail institucional, papeis de aluno/professor/admin, feed recomendado, posts, respostas, curtidas, reposts, busca, notificacoes, mensagens privadas, chamadas de voz 1 para 1 e painel de moderacao.

# Primeiro Usuario https://www.linkedin.com/in/felipe-amorim-pontes-9115833aa/

## Codigo comentado para aula

Os arquivos principais foram comentados com foco didatico, para ajudar em explicacoes com alunos:

- `src/server.js`: rotas da API, autenticacao, posts, uploads e moderacao.
- `src/db.js`: estrutura do banco SQLite e migracao.
- `src/auth.js`: senha, cookies e e-mail institucional.
- `src/config.js`: leitura do `.env`.
- `src/ranking.js`: logica do feed recomendado.
- `public/app.js`: interface, navegacao, compositor, timeline, perfil, mensagens, chamadas de voz e admin.
- `public/styles.css`: organizacao visual por secoes.
- `test/smoke.test.js`: teste automatizado do fluxo principal.
## Requisitos

- Ubuntu Server
- Node.js 24 ou superior

Nao ha dependencias externas no `package.json`. O banco usa o modulo nativo `node:sqlite`.

## Instalacao no Ubuntu Server

```bash
cd /opt
sudo mkdir six
sudo chown "$USER:$USER" six
cd six
```

Copie os arquivos deste projeto para `/opt/six`.

```bash
cp .env.example .env
nano .env
npm start
```

Tambem e possivel iniciar pelo script pronto:

```bash
bash start-ubuntu.sh
```

No `.env`, ajuste principalmente:

```bash
SIX_SCHOOL_NAME=Capitao Pedro Monteiro do Amaral
SIX_ALLOWED_EMAIL_DOMAINS=educacao.sp.gov.br,professor.educacao.sp.gov.br
SIX_HOST=0.0.0.0
SIX_PORT=3000
SIX_DB_PATH=./data/six.sqlite
```

Acesse na intranet:

```text
http://IP_DO_SERVIDOR:3000
```

## Admin inicial

Com `SIX_FIRST_USER_ADMIN=true`, a primeira conta criada com e-mail institucional vira admin. As proximas contas entram como alunos. Pelo painel `Equipe`, o admin pode promover usuarios para professor ou admin.

## Regras implementadas

- Somente e-mails dos dominios configurados podem criar conta.
- Alunos visualizam publicacoes de toda a escola.
- Publicacoes entram direto no feed.
- Usuario nao apaga publicacao diretamente; ele solicita exclusao.
- Apenas admin aprova ou rejeita exclusoes.
- Professores e admins acessam a area de equipe para acompanhar denuncias e solicitacoes.
- O feed recomendado combina recencia, curtidas, respostas, reposts, autores seguidos e sinal de equipe.

## Trocar o logo

Substitua o arquivo:

```text
public/assets/logo.svg
```

Use o mesmo nome de arquivo para nao precisar alterar codigo. Se preferir PNG/WebP, coloque o arquivo em `public/assets/` e altere as referencias em `public/index.html` e `public/app.js`.

## Rodar em segundo plano com systemd

O modelo esta em `deploy/six.service`. Copie para `/etc/systemd/system/six.service`:

```bash
sudo cp deploy/six.service /etc/systemd/system/six.service
```

Ative:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now six
sudo systemctl status six
```

## Testes

```bash
npm test
```

## Executar no Windows com Node.js

Abra o PowerShell na pasta do projeto e rode:

```powershell
.\start-windows.ps1
```

Depois acesse:

```text
http://127.0.0.1:3000
```

## Observacao sobre a referencia original

O repositorio `twitter/the-algorithm` e o codigo do algoritmo de recomendacao do X, nao o frontend completo da rede social. A SIX foi criada como uma aplicacao propria para intranet escolar, com layout inspirado em rede social de feed, nome e identidade separados.

## DNS local no Ubuntu Server

Para acessar pela intranet como `http://www.xis.com.br`, copie o projeto para o Ubuntu, preferencialmente em `/opt/six`, e rode:

```bash
cd /opt/six
sudo bash deploy/ubuntu-intranet-setup.sh www.xis.com.br IP_DO_SERVIDOR
```

Exemplo:

```bash
sudo bash deploy/ubuntu-intranet-setup.sh www.xis.com.br 192.168.0.188
```

O script configura:

- SIX como servico `systemd`
- Nginx na porta `80`, removendo a necessidade de `:3000`
- dnsmasq para resolver `www.xis.com.br` para o IP do servidor

Depois, no roteador Mercury/Mercusys, configure o DHCP para entregar o DNS primario como o IP do Ubuntu Server. Tambem reserve esse IP para o servidor.
## Chamadas de voz

A aba `Mensagens` permite chamada de voz 1 para 1. O navegador usa WebRTC para transmitir o audio diretamente entre os participantes, e o servidor Node.js faz apenas a sinalizacao da chamada.

Fluxo implementado:

- Botao `Ligar` no cabecalho da conversa.
- Painel flutuante para chamada recebida, com `Atender` e `Recusar`.
- Painel de chamada ativa, com `Encerrar`.
- Rotas `/api/calls` para criar, atender, recusar, encerrar e trocar sinais WebRTC.
- Tabelas `voice_calls` e `voice_call_signals` no SQLite.

Importante: Microsoft Edge, Chrome e outros navegadores modernos suportam WebRTC, mas o microfone so funciona em contexto seguro. Em `localhost` funciona para teste. Em outro computador/celular da rede usando `http://192.168.0.188:3000`, o Edge pode bloquear o microfone e parecer que nao suporta chamada. Para usar chamadas na intranet, publique com HTTPS, por exemplo usando os scripts em `deploy/ssl-self-signed-path.sh` ou `deploy/ssl-letsencrypt-path.sh`.
## Imagens em postagens

Usuarios podem publicar ate 4 imagens por postagem. Cada imagem pode ter no maximo 4 MB e deve ser PNG, JPG, WebP ou GIF. Os arquivos ficam em:

```text
data/uploads/posts/
```

Inclua `data/uploads/` no backup do servidor junto com `data/six.sqlite`.
## Imagens de perfil

Fotos e capas enviadas pelos usuarios ficam em:

```text
data/uploads/
```

Inclua `data/uploads/` no backup do servidor junto com `data/six.sqlite`.
## SSL/HTTPS

Para publicar na internet com certificado valido, use Let's Encrypt. Antes, o dominio precisa apontar no DNS publico para o IP publico do servidor, e as portas `80` e `443` precisam estar liberadas.

```bash
cd /opt/six
sudo bash deploy/ssl-letsencrypt.sh www.xis.com.br seu-email@dominio.com
```

Depois acesse:

```text
https://www.xis.com.br
```

Para intranet sem dominio publico, use certificado interno/self-signed:

```bash
cd /opt/six
sudo bash deploy/ssl-self-signed.sh www.xis.com.br IP_DO_SERVIDOR
```

Exemplo:

```bash
sudo bash deploy/ssl-self-signed.sh www.xis.com.br 192.168.0.188
```

Aviso: certificado interno/self-signed mostra alerta no navegador ate o certificado ser instalado como confiavel nos dispositivos.
## Publicar em www.capitao.tec.br/xis

Certificado SSL e emitido para o dominio `www.capitao.tec.br`; o `/xis` e configurado no Nginx como caminho publico da aplicacao.

Antes de rodar, crie no DNS publico:

```text
www.capitao.tec.br -> IP_PUBLICO_DO_SERVIDOR
```

No roteador/firewall, libere as portas `80` e `443` para o Ubuntu Server.

Com Let's Encrypt:

```bash
cd /opt/six
sudo bash deploy/ssl-letsencrypt-path.sh www.capitao.tec.br seu-email@dominio.com /xis
```

Acesse:

```text
https://www.capitao.tec.br/xis/
```

Para intranet/teste com certificado interno:

```bash
cd /opt/six
sudo bash deploy/ssl-self-signed-path.sh www.capitao.tec.br IP_DO_SERVIDOR /xis
```

Se `www.capitao.tec.br` ja hospeda outro site em outro servidor, voce precisa configurar o proxy nesse servidor existente ou apontar o DNS para o Ubuntu que vai hospedar a SIX.
## HTTPS local para chamadas de voz

O servidor Node.js pode rodar HTTP e HTTPS ao mesmo tempo para testes locais:

```text
http://127.0.0.1:3000
https://localhost:3443
```

O HTTPS local usa estes arquivos:

```text
certs/six-localhost.pfx
certs/six-localhost.cer
```

As variaveis ficam no `.env`:

```env
SIX_HTTPS_ENABLED=true
SIX_HTTPS_PORT=3443
SIX_SSL_PFX_PATH=./certs/six-localhost.pfx
SIX_SSL_PFX_PASSPHRASE=six-local-dev
```

Se o navegador mostrar aviso de certificado, execute em PowerShell como Administrador:

```powershell
cd C:\Users\sidne\OneDrive\Desktop\xis
powershell -ExecutionPolicy Bypass -File .\scripts\trust-local-cert.ps1
```

Depois feche e abra o navegador e acesse `https://localhost:3443`.
## AWS Ubuntu Server

Para preparar uma instancia Ubuntu na AWS, envie ou clone o projeto para a instancia e rode:

```bash
cd /opt/six
sudo bash deploy/aws-install-deps.sh /opt/six www.capitao.tec.br /xis
```

Se for testar apenas pelo IP publico da instancia, use:

```bash
cd /opt/six
sudo bash deploy/aws-install-deps.sh /opt/six _ /
```

O script instala Node.js 24, Nginx, SQLite, Certbot e cria o servico `six.service`.

Depois confira:

```bash
sudo systemctl status six
sudo journalctl -u six -f
```

Na AWS, libere no Security Group as portas TCP `22`, `80` e `443`.
