
document.addEventListener('DOMContentLoaded', function() {
    const modeToggle = document.getElementById('mode-toggle');
    const body = document.body;
    const toggleText = modeToggle.querySelector('.toggle-text');
    
    // Check for saved mode preference or default to 'professional'
    const currentMode = localStorage.getItem('mode') || 'professional';
    setMode(currentMode);
    
    modeToggle.addEventListener('click', function() {
        const isProfessional = body.classList.contains('professional-mode');
        const newMode = isProfessional ? 'traveler' : 'professional';
        setMode(newMode);
        localStorage.setItem('mode', newMode);
    });
    
    function setMode(mode) {
        if (mode === 'traveler') {
            body.classList.remove('professional-mode');
            body.classList.add('traveler-mode');
            toggleText.innerHTML = '💼 Professional';
        } else {
            body.classList.remove('traveler-mode');
            body.classList.add('professional-mode');
            toggleText.innerHTML = '🎒 Traveler';
        }
    }
    
    // Smooth scrolling for anchor links
    document.querySelectorAll('a[href^="#"]').forEach(anchor => {
        anchor.addEventListener('click', function (e) {
            e.preventDefault();
            const target = document.querySelector(this.getAttribute('href'));
            if (target) {
                target.scrollIntoView({
                    behavior: 'smooth',
                    block: 'start'
                });
            }
        });
    });
});