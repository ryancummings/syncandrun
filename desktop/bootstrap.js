window.bootstrap.onAddresses(({ addresses, changed }) => {
  document.getElementById("changed").hidden = !changed;
  const choices = document.getElementById("choices");
  addresses.forEach((address, index) => {
    const button = document.createElement("button");
    button.textContent = `Use http://${address}`;
    button.addEventListener("click", () => window.bootstrap.choose(index));
    choices.append(button);
  });
  const quit = document.createElement("button");
  quit.className = "secondary";
  quit.textContent = "Quit without enabling LAN access";
  quit.addEventListener("click", () => window.bootstrap.choose(addresses.length));
  choices.append(quit);
});
