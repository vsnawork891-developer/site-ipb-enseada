const menuButton = document.getElementById("menuButton");
const mainNav = document.getElementById("mainNav");

if (menuButton && mainNav) {

    menuButton.addEventListener("click", function () {

        mainNav.classList.toggle("open");

        const menuAberto = mainNav.classList.contains("open");

        menuButton.setAttribute(
            "aria-expanded",
            menuAberto ? "true" : "false"
        );

        menuButton.setAttribute(
            "aria-label",
            menuAberto ? "Fechar menu" : "Abrir menu"
        );
    });


    const links = mainNav.querySelectorAll("a");

    links.forEach(function (link) {

        link.addEventListener("click", function () {

            mainNav.classList.remove("open");

            menuButton.setAttribute(
                "aria-expanded",
                "false"
            );

            menuButton.setAttribute(
                "aria-label",
                "Abrir menu"
            );

        });

    });

}