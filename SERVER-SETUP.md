# 发压机部署手册(Podman 方式)

> 适用:RHEL + rootless Podman 的 Linux 发压机,k6 以容器镜像方式运行(镜像来自
> 内部 registry,版本已钉定)。全流程无需 root。
> 命令里的 `<server>`、`<REPOSITORY>:<TAG>` 等尖括号项按实际环境替换,真实值不回填进本仓库。

## 0. 前提

- 服务器可用 rootless Podman(`podman info` 正常);
- 钉定版本的 k6 镜像已从内部 registry 拉到本地(`podman images` 能看到);
- 部署 git bundle 路线需要服务器有 git(`git --version`)。

## 1. 代码上服务器

### 路线一(推荐):git bundle —— 行尾与执行位由 git 自动还原,零补针

```bash
# Windows 机 Git Bash,在仓库检出目录:
git pull
git bundle create k6-pt.bundle main
# 把单文件 k6-pt.bundle 用 SFTP 传到服务器,然后在服务器上:
cd <部署根目录>
git clone -b main k6-pt.bundle perf
cd perf && ls -l run.sh          # 应直接是 -rwxr-xr-x,无需 chmod
```

以后更新代码:Windows 重新 bundle 覆盖上传,服务器上:

```bash
cd <部署根目录>/perf
git stash && git pull ../k6-pt.bundle main && git stash pop
# stash/pop 保护服务器本地改过的 config/environments/*.json 真实配置不被冲掉
```

### 路线二:scp / SFTP / zip 直传 —— 传完必须补两针

Windows 侧实体化过的文件会丢执行位,git 检出还可能带 CRLF 行尾。传完在服务器上:

```bash
cd <部署目录>
chmod +x run.sh prep.sh scripts/*.sh
file run.sh                                        # 显示 CRLF 即中招,执行下两行
sed -i 's/\r$//' run.sh prep.sh scripts/*.sh       # 只需修 .sh;js/json 不受影响
sed -i 's/\r$//' ~/bin/k6                          # 垫片已按 §2 装过的话,装出去的副本一并修
```

**警告**:绝不要对 `data/datfiles/` 下的二进制 .dat 样本跑 sed/dos2unix——改一个字节就废。

zip 解压是否完成的判据:输出滚完回到提示符,`echo $?` 为 0;
完备性核对 `unzip -l <包>.zip | tail -1` 的文件数与 `find <目录> -type f | wc -l` 一致。

## 2. 安装 k6 垫片(把容器包装成 `k6` 命令)

run.sh/prep.sh 只认 PATH 里名为 `k6` 的命令;镜像本身不提供命令名,垫片补上这一环:

```bash
cd <部署目录>
mkdir -p ~/bin && cp scripts/k6-podman-shim.sh ~/bin/k6 && chmod +x ~/bin/k6
```

## 3. 一次性环境变量(写进 ~/.bashrc,以后不用再做)

```bash
podman images    # 抄下镜像的 REPOSITORY 和 TAG 两列

cat >> ~/.bashrc <<'EOF'
export PATH="$HOME/bin:$PATH"
export K6_IMAGE=<REPOSITORY>:<TAG>
export K6_INSECURE_SKIP_TLS_VERIFY=true
EOF
source ~/.bashrc
```

- `K6_IMAGE` 必填、无默认:防 latest 漂移毁基线可比性;镜像引用含内部 registry
  主机名,属环境事实,只存在于服务器 `.bashrc`,永不入库。
- `K6_INSECURE_SKIP_TLS_VERIFY=true` 是对自签证书环境的显式决定;它是环境偏差,
  测试报告的环境说明里须记一句"TLS 校验关闭"。

## 4. 真实环境配置(只在服务器上改,永不回传入 git)

```bash
vi config/environments/dev.json
# gatewayUrl / 身份池账号 / promRwUrl / grafanaDashboard → 填真实值
```

## 5. 验证链(不发任何流量)

```bash
which k6         # 应指向 ~/bin/k6(垫片)
k6 version       # 走垫片启动容器,应打印钉定版本 → 垫片+镜像+版本一次验证
k6 inspect -e ENV=dev src/scenarios/trades-query.js    # 脚本+配置静态装配验证
```

## 6. 首次铺池(该环境第一次跑该场景才需要;会发真实请求)

```bash
./prep.sh trade-mix-full dev smoke
# trade-mix-full 链式自供数,此步只铺 amend-cycle-ids 永久池与 trade-ids 读池;
# reject 归还每个 id,后续测量轮无需重复。池被 409 毒化时才重新 seed。
```

## 7. smoke 与判定

```bash
./run.sh trade-mix-full dev smoke
```

- 判定看 `results/<UTC日期>/<runId>/summary.txt`:technical/business/script 三类全零即过;
- `ls -l results/` 确认文件属主是当前用户(容器方式下这是 keep-id 参数的专项验证点);
- 通过后小流量试跑 `./run.sh trade-mix-full dev mix RATE=4 DURATION=1m`,
  确认 Grafana 出点,再进 CAPACITY-TEST-PLAN.md 的执行矩阵。

## 8. 常见故障速查

| 症状 | 原因 → 处置 |
|---|---|
| `k6: command not found` | 垫片未安装或 `~/bin` 不在 PATH → 重做第 2、3 步,`which k6` 验证 |
| `K6_IMAGE: set K6_IMAGE to...` | 环境变量未设置 → 第 3 步;新开 shell 记得 `source ~/.bashrc` |
| 启动时报镜像拉取/解析失败 | `K6_IMAGE` 与 `podman images` 里的引用不一致 → 逐字核对 |
| `/usr/bin/env: 'bash\r': No such file or directory`、`bad interpreter` 或诡异语法错 | CRLF 行尾(zip/Windows 中转带入,`\r` 是被显式打印的不可见回车)→ §1 路线二的两行 `sed` 补针(含 `~/bin/k6`),或改走 bundle 路线根治 |
| `Permission denied` 执行 .sh | 执行位丢失 → `chmod +x` |
| results 文件属主是一串数字 | 垫片被绕过或 keep-id 参数被改 → 确认走 `~/bin/k6` 原版垫片 |
| TLS x509 证书错误 | `K6_INSECURE_SKIP_TLS_VERIFY` 未生效 → `echo` 检查,注意变量要在跑测的 shell 里 |
| `PLAN dry-run produced no POOLPLAN lines` | 容器方式下框架脚本引用了挂载树($PWD)之外的路径(如 /tmp),文件随容器销毁 → 已修(prep.sh 计划日志改为树内路径);若复现,检查报错命令是否还有树外路径 |
| 长轮跑一半会话被踢 | SSH 空闲自动登出策略 → `nohup ./run.sh ... > run.log 2>&1 &`,soak 必用 |

## 9. 纪律回顾(两条腿)

- **代码**走 git(bundle 或直传):Mac → 公开仓库 → Windows 机 → 服务器;
- **环境事实**(镜像引用、网关地址、账号、TLS 决定)只活在服务器本地
  (`.bashrc` + `config/environments/`),两条腿永不交叉。
