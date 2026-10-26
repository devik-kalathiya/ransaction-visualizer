const sections = document.querySelectorAll(".topic");
const links = document.querySelectorAll(".sidebar a");

const observer = new IntersectionObserver(
  entries => {
    entries.forEach(entry => {
      if (!entry.isIntersecting) return;

      links.forEach(link => {
        link.classList.remove("active");
      });

      const active = document.querySelector(
        `.sidebar a[href="#${entry.target.id}"]`
      );

      if (active) {
        active.classList.add("active");
      }
    });
  },
  {
    rootMargin: "-15% 0px -70% 0px"
  }
);

sections.forEach(section => {
  observer.observe(section);
});