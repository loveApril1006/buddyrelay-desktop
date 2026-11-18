(() => {
  if (web || mode !== "window") return;

  const releaseURL = "https://github.com/loveApril1006/buddyrelay-desktop/releases/latest";
  const entry = document.getElementById("buddyrelayOpen");
  const dialog = document.getElementById("buddyrelayDialog");
  const status = document.getElementById("buddyrelayStatus");
  const buttons = [...dialog.querySelectorAll("button[data-buddyrelay-action]")];
  const zh = () => document.documentElement.lang.startsWith("zh");

  entry.addEventListener("click", () => {
    status.textContent = "";
    dialog.querySelector("h2").textContent = zh() ? "WorkBuddy 管理" : "WorkBuddy management";
    dialog.querySelector("p").textContent = zh()
      ? "启用 WorkBuddy 的 API 反代后，将相应版本接入 Magpie 的供应商列表。"
      : "Enable your WorkBuddy API relay, then connect its edition to Magpie’s Providers.";
    for (const button of dialog.querySelectorAll("[data-en]")) {
      button.textContent = zh() ? button.dataset.zh : button.dataset.en;
    }
    dialog.showModal();
  });

  for (const button of buttons) {
    button.addEventListener("click", async () => {
      const action = button.dataset.buddyrelayAction;
      for (const item of buttons) item.disabled = true;
      status.textContent = "";
      try {
        if (action === "update") {
          await api("open", { url: releaseURL });
          return;
        }
        const response = await fetch("/api/buddyrelay/" + action, { method: "POST" });
        if (!response.ok) throw new Error((await response.text()).trim());
        if (action === "open") {
          dialog.close();
        } else {
          const { modelsLoaded } = await response.json();
          if (modelsLoaded) {
            status.textContent = zh() ? "已接入。请到供应商页选择模型。" : "Connected. Choose models in Providers.";
          } else {
            status.textContent = zh()
              ? "已保存供应商，暂未读到模型。请确认该版本的反代和账号已就绪，再次接入。"
              : "Provider saved. Once the relay and its accounts are ready, reconnect to load models.";
          }
        }
      } catch (error) {
        status.textContent = zh() ? error.message : "Request failed. Check WorkBuddy’s API relay settings.";
      } finally {
        for (const item of buttons) item.disabled = false;
      }
    });
  }

  fetch("/api/buddyrelay").then((response) => {
    if (response.status === 204) entry.hidden = false;
  }).catch(() => {});
})();
