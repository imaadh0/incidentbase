import { ArrowRight, Clock3, Radio, ShieldCheck, Waypoints } from 'lucide-react';
import Link from 'next/link';

import { IncidentDashboard } from '../components/incident-dashboard';
import { ThemeToggle } from '../components/theme-toggle';
import { demoIncidents, demoMembers } from '../lib/demo-data';

export default function LandingPage() {
  return (
    <div className="marketing-page">
      <header className="marketing-header">
        <Link className="brand" href="/" aria-label="IncidentBase home">
          <span className="brand-mark brand-square">
            <span className="logo-glyph" />
          </span>
          <span>IncidentBase</span>
        </Link>
        <nav aria-label="Main navigation">
          <a href="#why">Why IncidentBase</a>
          <a href="#product">Product</a>
        </nav>
        <div className="marketing-actions">
          <ThemeToggle compact />
          <Link className="text-link" href="/sign-in">
            Sign in
          </Link>
          <Link className="header-demo" href="/demo">
            View demo <ArrowRight size={15} />
          </Link>
        </div>
      </header>

      <main>
        <section className="marketing-hero">
          <div className="hero-copy">
            <p className="eyebrow">
              <span className="eyebrow-line" /> INCIDENT RESPONSE, IN ONE PLACE
            </p>
            <h1>Keep the response moving.</h1>
            <p className="hero-description">
              When something breaks, everyone should know what happened, who owns the next step, and
              what changed. IncidentBase gives your team a clear place to respond.
            </p>
            <div className="hero-actions">
              <Link className="hero-primary" href="/sign-in">
                Sign in <ArrowRight size={17} />
              </Link>
              <Link className="hero-secondary" href="/demo">
                View demo <ArrowRight size={17} />
              </Link>
            </div>
            <p className="hero-footnote">
              <span className="live-pip" /> A focused workspace for every incident.
            </p>
          </div>
          <div className="hero-visual" aria-hidden="true">
            <div className="hero-visual-top">
              <span />
              <span />
              <span />
              <strong>RESPONSE / OVERVIEW</strong>
            </div>
            <div className="hero-visual-body">
              <div className="mini-sidebar">
                <span className="logo-glyph" />
                <i />
                <i />
                <i />
              </div>
              <div className="mini-content">
                <div className="mini-heading">
                  <small>WORKSPACE / INCIDENTS</small>
                  <strong>Response overview</strong>
                </div>
                <div className="mini-metrics">
                  <div>
                    <small>ACTIVE INCIDENTS</small>
                    <strong>03</strong>
                  </div>
                  <div>
                    <small>AWAITING RESPONSE</small>
                    <strong>01</strong>
                  </div>
                  <div>
                    <small>INVESTIGATING</small>
                    <strong>01</strong>
                  </div>
                </div>
                <div className="mini-panels">
                  <div className="mini-bars">
                    <small>RESPONSE ACTIVITY</small>
                    <span>
                      <i />
                      <i />
                      <i />
                      <i />
                      <i />
                      <i />
                      <i />
                    </span>
                  </div>
                  <div className="mini-ring">
                    <small>SEVERITY MIX</small>
                    <span />
                  </div>
                </div>
                <div className="mini-queue">
                  <small>INCIDENT QUEUE</small>
                  <span>
                    INC-1042 <b>API latency in primary region</b>
                    <em>SEV1</em>
                  </span>
                  <span>
                    INC-1041 <b>Checkout queue processing delay</b>
                    <em>SEV2</em>
                  </span>
                </div>
              </div>
            </div>
          </div>
        </section>

        <section className="feature-section" id="why">
          <div className="section-intro">
            <p className="eyebrow">THE WORK THAT MATTERS</p>
            <h2>Clarity for the moments that usually get messy.</h2>
            <p>One record for the response, from first report through resolution.</p>
          </div>
          <div className="feature-grid">
            <article className="feature-card">
              <div className="feature-icon">
                <Radio size={22} />
              </div>
              <span>01 / VISIBILITY</span>
              <h3>A live queue for the whole team</h3>
              <p>
                See the incidents that need attention, their severity, status, and current responder
                without chasing updates across channels.
              </p>
            </article>
            <article className="feature-card">
              <div className="feature-icon">
                <Waypoints size={22} />
              </div>
              <span>02 / OWNERSHIP</span>
              <h3>The next step has an owner</h3>
              <p>
                Assign responders, acknowledge work, and escalate when the first response does not
                happen in time.
              </p>
            </article>
            <article className="feature-card">
              <div className="feature-icon">
                <ShieldCheck size={22} />
              </div>
              <span>03 / ACCOUNTABILITY</span>
              <h3>A timeline you can trust</h3>
              <p>
                Follow the response from declaration to resolution with a durable record of the
                decisions and actions taken.
              </p>
            </article>
          </div>
        </section>

        <section className="product-section" id="product">
          <div className="product-intro">
            <div>
              <p className="eyebrow">A CLOSER LOOK</p>
              <h2>Your response, at a glance.</h2>
              <p>
                The preview below uses sample incidents and the same dashboard components as the
                live workspace.
              </p>
            </div>
            <Link href="/demo">
              Explore the demo <ArrowRight size={17} />
            </Link>
          </div>
          <div className="product-preview">
            <div className="preview-rail">
              <span className="logo-glyph" />
              <i />
              <i />
              <i />
            </div>
            <div className="preview-main">
              <div className="preview-breadcrumb">
                <span>Workspace / Incidents</span>
                <span>
                  <Clock3 size={14} /> Sample dashboard
                </span>
              </div>
              <IncidentDashboard
                incidents={demoIncidents}
                members={demoMembers}
                organizationName="Atlas Operations"
                sample
                preview
              />
            </div>
          </div>
        </section>

        <section className="closing-cta">
          <div>
            <p className="eyebrow">READY WHEN YOUR TEAM IS</p>
            <h2>Make the next response easier to run.</h2>
          </div>
          <div>
            <Link className="hero-primary" href="/sign-in">
              Sign in <ArrowRight size={17} />
            </Link>
            <Link className="hero-secondary" href="/demo">
              View demo <ArrowRight size={17} />
            </Link>
          </div>
        </section>
      </main>
      <footer className="marketing-footer">
        <span>IncidentBase</span>
        <span>Clear ownership. A complete response record.</span>
      </footer>
    </div>
  );
}
