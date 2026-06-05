# ZimaOS Docker Stack with CouchDB & Ollama Setup Guide

This guide details how to build, deploy, and run this premium **Atreus** application inside a Docker container on **ZimaOS** (or any generic Linux container host), configuring it to persist all tasks, sections, settings, and logs inside a single new **CouchDB** database and integrate with **Ollama** running natively on the host server.

---

## 1. Prerequisites

Before starting, ensure that:
1. **Docker** and **Docker Compose** are installed (pre-installed on ZimaOS).
2. **Ollama** is running on your host server (binded to port `11434`).
3. You have CouchDB running (either as a companion container in this stack or an external instance).

---

## 2. Docker Stack Architecture

The `docker-compose.yml` launches two containerized services:
* **`atreus`**: The web application backend (FastAPI) and front-end bundle.
* **`couchdb`**: A NoSQL document database. When `COUCHDB_URL` is set, the application automatically initializes a single database called `atreus` inside CouchDB to hold settings, logs, projects, sections, and task documents.

```
                    +------------------------------------------+
                    |           ZimaOS / Host OS               |
                    |                                          |
                    |                  +----------+            |
                    |                  |  Ollama  |            |
                    |                  | (11434)  |            |
                    |                  +----------+            |
                    |                       ^                  |
                    |                  Bind |                  |
                    |                  Port |                  |
                    |                       |                  |
                    |  +--------------------+                  |
                    |  |       atreus       |                  |
                    |  |   Container (8000) |                  |
                    |  +--------------------+                  |
                    |          |                               |
                    |          | Docker Link                   |
                    |          v                               |
                    |  +--------------------+                  |
                    |  |    atreus-couch    |                  |
                    |  |   Container (5984) |                  |
                    |  +--------------------+                  |
                    +------------------------------------------+
```

---

## 3. Configuration Step-by-Step

### Step 1: Configure Ollama Host Permissions
By default, Ollama only listens to connections originating from `localhost` (`127.0.0.1`). Since our backend runs inside a container, it must connect via the docker network bridge gateway.

To allow Ollama to accept container requests:
1. On your host system, set the environment variable:
   ```bash
   OLLAMA_HOST=0.0.0.0
   ```
2. Restart the Ollama daemon:
   * **Systemd (most Linux systems):**
     ```bash
     sudo systemctl edit ollama
     # Add the following lines inside the override block:
     [Service]
     Environment="OLLAMA_HOST=0.0.0.0"
     
     # Save the file, reload, and restart:
     sudo systemctl daemon-reload
     sudo systemctl restart ollama
     ```

### Step 2: Run the Stack
Run the following command inside your project directory to build and spin up the containers:

```bash
docker compose up -d --build
```

---

## 4. Setup CouchDB Single-Node Mode

CouchDB requires a one-time initial setup to configure single-node mode, enabling document insertions and Mango querying.

1. Open a browser and navigate to **Fauxton** (CouchDB's administration dashboard):
   ```
   http://<YOUR-ZIMAOS-IP>:5984/_utils/
   ```
2. Log in with the credentials specified in your `docker-compose.yml` file:
   * **Username:** `admin`
   * **Password:** `adminpassword`
3. Click the **Setup** tab on the left sidebar.
4. Select **"Configure Single Node"**.
5. Keep the pre-filled username and password, enter `127.0.0.1` as the bind address, and click **Configure Node**.
6. **Done!** The application backend will automatically detect the database and create a single `atreus` database on startup with all required selector indexes (`type` and `timestamp`).

---

## 5. Connecting the App to Ollama

1. Open the application portal in your browser at `http://<YOUR-ZIMAOS-IP>:8000/`.
2. Go to **Settings** (bottom left menu).
3. Set the **Local Ollama API Service URL** to:
   ```
   http://host.docker.internal:11434
   ```
   *(The `extra_hosts` block inside `docker-compose.yml` ensures that `host.docker.internal` automatically resolves to your host's internal gateway IP.)*
4. Input your model name (e.g. `llama3`, `mistral`, or `gemma`) in the **Ollama Model Name** field.
5. Click **Save Configurations**. Your private local AI Assistant is now online and connected!
